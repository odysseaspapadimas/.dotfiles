import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface MailboxIdentity {
  sessionId: string;
  sessionPath: string;
  paneId: string;
}
export interface DeliveryReceipt {
  messageId: string;
  state: "queued" | "accepted" | "unknown" | "rejected";
  entryId?: string;
  error?: string;
}
interface Request extends MailboxIdentity {
  action: "hello" | "send" | "status" | "pending";
  messageId?: string;
  message?: string;
}
interface Response {
  runtimeId?: string;
  delivery?: DeliveryReceipt;
  pending?: boolean;
  error?: string;
}
interface Record {
  message: string;
  receipt: DeliveryReceipt;
  dispatchedAt?: number;
}
interface Receiver {
  isCurrent(): boolean;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  deliver(content: string): void;
  findAccepted(messageId: string): { entryId: string; content: string } | undefined;
  onError(error: unknown): void;
}
const MAX_FRAME = 256 * 1024;
const ID = /^[0-9a-f-]{36}:[0-9a-f-]{36}$/u;
export function messageMarker(messageId: string): string { return `[pi_sessions:${messageId}]\n`; }

function address(root: string, identity: MailboxIdentity): string {
  const key = createHash("sha256").update(JSON.stringify([identity.sessionId, identity.sessionPath, identity.paneId])).digest("hex").slice(0, 24);
  const path = join(root, `${key}.sock`);
  if (process.platform === "win32" || Buffer.byteLength(path) > 103) {
    throw new Error("Pi session mailbox requires a Unix socket path of at most 103 bytes");
  }
  return path;
}

/** A private, in-process mailbox. It never reads, writes, or submits the editor draft. */
export class SessionMailbox {
  readonly runtimeId = randomUUID();
  private records = new Map<string, Record>();
  private server?: Server;
  private sockets = new Set<Socket>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = true;
  private pumping = false;

  constructor(private root: string, private identity: MailboxIdentity, private receiver: Receiver) {}

  async start(): Promise<void> {
    const path = address(this.root, this.identity);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    // Never unlink a live receiver, or an unrelated file, when recovering a stale socket.
    try {
      if (!(await lstat(path)).isSocket()) throw new Error(`Not a mailbox socket: ${path}`);
      const alive = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection(path);
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Existing mailbox is unresponsive")); });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
          else reject(error);
        });
      });
      if (alive) throw new Error("A receiver already owns this Pi session/pane mailbox");
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => this.connection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", (error) => this.receiver.onError(error));
    try { await chmod(path, 0o600); }
    catch (error) { await this.close(); throw error; }
    this.closed = false;
    server.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.records.clear();
  }

  /** Called after user-message persistence and agent_settled; also polls only while queued. */
  wake(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 0);
    this.timer.unref();
  }

  private refresh(): void {
    for (const [id, record] of this.records) {
      if (record.dispatchedAt === undefined || record.receipt.state === "accepted" || record.receipt.state === "rejected") continue;
      const accepted = this.receiver.findAccepted(id);
      if (accepted) record.receipt = { messageId: id, state: "accepted", entryId: accepted.entryId };
      else if (record.dispatchedAt && Date.now() - record.dispatchedAt > 30_000) {
        record.receipt = { messageId: id, state: "unknown", error: "Pi has not persisted this message. It will not be automatically resent." };
      }
    }
  }

  private pump(): void {
    if (this.closed || this.pumping || !this.receiver.isCurrent()) return;
    this.pumping = true;
    try {
      this.refresh();
      const outstanding = [...this.records.values()].some((record) =>
        record.receipt.state === "unknown" || record.receipt.state === "queued" && record.dispatchedAt !== undefined);
      if (!outstanding && this.receiver.isIdle() && !this.receiver.hasPendingMessages()) {
        const next = [...this.records.values()].find((record) => record.receipt.state === "queued");
        if (next) {
          // Claim before invoking Pi: a lost acknowledgment must never cause another injection.
          next.dispatchedAt = Date.now();
          try { this.receiver.deliver(messageMarker(next.receipt.messageId) + next.message); }
          catch (error) {
            next.receipt = { messageId: next.receipt.messageId, state: "unknown", error: String(error) };
          }
          this.refresh();
        }
      }
    } catch (error) { this.receiver.onError(error); }
    finally {
      this.pumping = false;
      if (!this.closed && !this.timer && [...this.records.values()].some((record) => record.receipt.state === "queued")) {
        this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 250);
        this.timer.unref();
      }
    }
  }

  private async handle(request: Request): Promise<Response> {
    if (this.closed || !this.receiver.isCurrent() || request.sessionId !== this.identity.sessionId ||
      request.sessionPath !== this.identity.sessionPath || request.paneId !== this.identity.paneId) {
      return { error: "Mailbox target changed; refusing cross-session delivery" };
    }
    if (request.action === "hello") return { runtimeId: this.runtimeId };
    if (request.action === "pending") {
      this.refresh();
      return { pending: [...this.records.values()].some((record) => ["queued", "unknown"].includes(record.receipt.state)) };
    }
    const id = request.messageId;
    if (!id || !ID.test(id)) return { error: "Invalid mailbox messageId" };
    if (request.action !== "send" && request.action !== "status") return { error: "Unknown mailbox action" };
    if (request.action === "send" && (typeof request.message !== "string" || !request.message.trim() || Buffer.byteLength(request.message) > 128 * 1024)) {
      return { error: "Mailbox message must contain 1–128KB of text" };
    }
    const accepted = this.receiver.findAccepted(id);
    const existing = this.records.get(id);
    if (request.action === "send" && (existing && existing.message !== request.message ||
      accepted && accepted.content !== messageMarker(id) + request.message)) {
      return { error: "messageId was already used for a different message" };
    }
    if (accepted) return { delivery: { messageId: id, state: "accepted", entryId: accepted.entryId } };
    if (existing) { this.pump(); return { delivery: { ...existing.receipt } }; }
    if (!id.startsWith(`${this.runtimeId}:`)) {
      return { delivery: { messageId: id, state: "unknown", error: "The receiver restarted or changed. Delivery is unconfirmed; inspect history before sending a new message. Nothing was resent." } };
    }
    if (request.action === "status") return { delivery: { messageId: id, state: "unknown", error: "This receiver has no record of that message" } };
    // Accepted receipts can be recovered from the transcript, so retain only a bounded hot set.
    if (this.records.size >= 256) for (const [key, record] of this.records) {
      if (record.receipt.state === "accepted") this.records.delete(key);
    }
    if (this.records.size >= 256) return { error: "Pi session mailbox is full; inspect pending messages first" };
    const record: Record = { message: request.message!, receipt: { messageId: id, state: "queued" } };
    this.records.set(id, record);
    this.pump();
    if (record.dispatchedAt) {
      // An idle receiver usually persists the user entry immediately. Otherwise report queued,
      // not accepted: sendUserMessage is fire-and-forget and can fail asynchronously.
      await delay(50);
      if (!this.closed && this.receiver.isCurrent()) this.refresh();
    }
    return { delivery: { ...record.receipt } };
  }

  private connection(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(2000, () => socket.destroy());
    let buffer = "";
    let bytes = 0;
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_FRAME) { socket.destroy(); return; }
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      handled = true;
      void (async () => {
        try { socket.end(`${JSON.stringify(await this.handle(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))))}\n`); }
        catch (error) { socket.end(`${JSON.stringify({ error: String(error) })}\n`); }
      })();
    });
  }
}

async function request(root: string, identity: MailboxIdentity, body: Omit<Request, keyof MailboxIdentity>, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const frame = `${JSON.stringify({ ...identity, ...body })}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("Pi mailbox request is too large");
  return new Promise((resolve, reject) => {
    const socket = createConnection(address(root, identity));
    let buffer = "";
    let done = false;
    const finish = (error?: unknown, result?: Response) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal?.reason ?? new Error("Mailbox request aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => finish(new Error("Pi mailbox acknowledgment timed out")));
    socket.once("connect", () => socket.write(frame));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => { if (!done) finish(new Error("Pi mailbox closed before acknowledging the request")); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) { finish(new Error("Invalid mailbox response")); return; }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Response;
        finish(response.error ? new Error(response.error) : undefined, response);
      } catch (error) { finish(error); }
    });
  });
}

function receipt(response: Response, messageId: string): DeliveryReceipt {
  const delivery = response.delivery;
  if (!delivery || delivery.messageId !== messageId || !["queued", "accepted", "unknown", "rejected"].includes(delivery.state) ||
    delivery.state === "accepted" && (typeof delivery.entryId !== "string" || !delivery.entryId)) {
    throw new Error("Invalid mailbox delivery acknowledgment");
  }
  return delivery;
}

export async function sendMailbox(root: string, identity: MailboxIdentity, message: string, messageId?: string, signal?: AbortSignal): Promise<DeliveryReceipt> {
  try {
    if (!messageId) {
      const hello = await request(root, identity, { action: "hello" }, signal);
      if (typeof hello.runtimeId !== "string" || !/^[0-9a-f-]{36}$/u.test(hello.runtimeId)) throw new Error("Invalid mailbox handshake");
      messageId = `${hello.runtimeId}:${randomUUID()}`;
    }
    const response = await request(root, identity, { action: "send", message, messageId }, signal);
    const delivery = receipt(response, messageId);
    if (["unknown", "rejected"].includes(delivery.state)) throw new Error(delivery.error ?? delivery.state);
    return delivery;
  } catch (error) {
    throw new Error(`PI_SESSIONS_MAILBOX ${JSON.stringify({ messageId, sessionId: identity.sessionId })}\n${String(error)}\n${messageId
      ? "Delivery is unconfirmed. Check status with this messageId, or retry the SAME messageId and message; do not blindly resend with a new ID."
      : "No message was submitted. Reload the TARGET session to enable its mailbox, then retry. Terminal input fallback is disabled."}`);
  }
}

export async function mailboxStatus(root: string, identity: MailboxIdentity, messageId: string, signal?: AbortSignal): Promise<DeliveryReceipt> {
  const response = await request(root, identity, { action: "status", messageId }, signal);
  return receipt(response, messageId);
}

export async function mailboxPending(root: string, identity: MailboxIdentity, signal?: AbortSignal): Promise<boolean> {
  try { return (await request(root, identity, { action: "pending" }, signal)).pending !== false; }
  catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error; // Fail closed on an unresponsive receiver during automatic task cleanup.
  }
}
