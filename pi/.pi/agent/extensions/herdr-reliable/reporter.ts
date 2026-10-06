import net from "node:net";
import { randomUUID } from "node:crypto";

const SOURCE = "herdr:pi";
const sequences = Symbol.for("local.herdr-reliable.sequences");

export type Snapshot = {
  state: "idle" | "working" | "blocked";
  message?: string;
  sessionPath?: string;
  sessionId?: string;
  reason?: string;
};

type Options = {
  socketPath: string;
  paneId: string;
  snapshot: () => Snapshot;
  heartbeatMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  timeoutMs?: number;
};

// Keep sequences monotonic through /reload and a backwards NTP clock correction.
function nextSequence(paneId: string): number {
  const globals = globalThis as typeof globalThis & { [sequences]?: Map<string, number> };
  const counters = globals[sequences] ??= new Map();
  const next = Math.max(Date.now() * 1000, (counters.get(paneId) ?? 0) + 1);
  counters.set(paneId, next);
  return next;
}

export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs = 1500,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Herdr reporter stopped"));
      return;
    }
    const id = `local:pi:${randomUUID()}`;
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new Error("Herdr reporter stopped"));
    const timeout = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", error => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("end", () => finish(new Error("Herdr closed before acknowledging the report")));
    socket.on("data", data => {
      buffer += data.toString();
      if (buffer.length > 65536) {
        finish(new Error("Herdr response exceeded 64 KiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id) throw new Error("Herdr response ID did not match");
        if (response.error) {
          throw new Error(`Herdr ${response.error.code ?? "error"}: ${response.error.message ?? "request rejected"}`);
        }
        if (!("result" in response)) throw new Error("Herdr response had no result");
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function sessionParams(snapshot: Snapshot): Record<string, unknown> {
  if (snapshot.sessionPath) return { agent_session_path: snapshot.sessionPath };
  if (snapshot.sessionId) return { agent_session_id: snapshot.sessionId };
  throw new Error("Pi has not provided a native session reference yet");
}

function sameSession(pane: any, snapshot: Snapshot): boolean {
  return pane?.agent === "pi" && pane.agent_session?.source === SOURCE &&
    pane.agent_session.value === (snapshot.sessionPath ?? snapshot.sessionId);
}

function stateMatches(pane: any, snapshot: Snapshot): boolean {
  return sameSession(pane, snapshot) && (pane.agent_status === snapshot.state ||
    (snapshot.state === "idle" && pane.agent_status === "done"));
}

export class Reporter {
  private options: Options;
  private controller = new AbortController();
  private heartbeat?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private running?: Promise<boolean>;
  private dirty = false;
  private retryDelay: number;
  lastError?: string;

  constructor(options: Options) {
    this.options = options;
    this.retryDelay = options.retryMs ?? 500;
  }

  start(): void {
    if (this.controller.signal.aborted || this.heartbeat) return;
    this.heartbeat = setInterval(() => void this.refresh(), this.options.heartbeatMs ?? 15000);
    this.heartbeat.unref?.();
    void this.refresh();
  }

  refresh(): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false);
    this.dirty = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  private async send(method: string, params: Record<string, unknown>): Promise<any> {
    return request(this.options.socketPath, method, params, this.controller.signal, this.options.timeoutMs);
  }

  private async synchronize(snapshot: Snapshot): Promise<void> {
    const base = {
      pane_id: this.options.paneId,
      source: SOURCE,
      agent: "pi",
      ...sessionParams(snapshot),
    };
    // Serialize identity before state; independent sockets can otherwise reorder sequences.
    // Retain the startup reason on retries so Herdr can reanchor a restored process.
    await this.send("pane.report_agent_session", {
      ...base, seq: nextSequence(this.options.paneId), session_start_source: snapshot.reason ?? "reload",
    });
    const state = { ...base, state: snapshot.state, message: snapshot.message };
    await this.send("pane.report_agent", { ...state, seq: nextSequence(this.options.paneId) });
    let result = await this.send("pane.get", { pane_id: this.options.paneId });
    if (!stateMatches(result?.pane, snapshot) && sameSession(result?.pane, snapshot)) {
      // The previous managed hook may have a future-dated sequence from boot before NTP.
      // Only bypass that sequence when Herdr already confirms this exact native session.
      // Herdr still validates process generation and lifecycle ownership on this report.
      await this.send("pane.report_agent", state);
      result = await this.send("pane.get", { pane_id: this.options.paneId });
    }
    if (!stateMatches(result?.pane, snapshot)) {
      throw new Error("Herdr acknowledged but has not applied Pi's session/status yet");
    }
  }

  private async drain(): Promise<boolean> {
    while (this.dirty && !this.controller.signal.aborted) {
      this.dirty = false;
      try {
        await this.synchronize(this.options.snapshot());
        this.lastError = undefined;
        this.retryDelay = this.options.retryMs ?? 500;
      } catch (error) {
        if (this.controller.signal.aborted) return false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.dirty = true;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.refresh();
        }, this.retryDelay);
        this.retry.unref?.();
        this.retryDelay = Math.min(this.retryDelay * 2, this.options.maxRetryMs ?? 10000);
        return false;
      }
    }
    return !this.controller.signal.aborted;
  }

  dispose(): void {
    this.controller.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    this.heartbeat = undefined;
    this.retry = undefined;
    this.dirty = false;
  }
}
