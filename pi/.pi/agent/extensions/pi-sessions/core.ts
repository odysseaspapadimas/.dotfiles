import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export type SessionBackend = "tui" | "core" | "none";

/** Explicit TUI context wins over HC variables inherited by a nested old Herdr. */
export function sessionBackend(env: NodeJS.ProcessEnv): SessionBackend {
  if (env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID) return "tui";
  if (env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET) return "core";
  return "none";
}

export interface CorePane {
  pane_id: string;
  agent?: string;
  agent_status?: "idle" | "working" | "blocked" | "done" | "error" | "unknown";
  workspace_id?: string;
  tab_id?: string;
  agent_session?: { kind: string; value: string };
}
interface ProcessInfo { argv?: string[]; cwd?: string; pid?: number; name?: string }
export interface CoreTerminal {
  address: string;
  state: string;
  argv: string[];
  cwd: string;
  foreground?: ProcessInfo | null;
  labels: Record<string, string>;
  status?: { app?: string; state?: string } | null;
}
interface Session { sessionId: string; sessionPath: string; name: string; cwd: string }
type AppExec = (args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

const PATH_LABEL = "pi-sessions.path";
const ID_LABEL = "pi-sessions.id";
const PID_LABEL = "pi-sessions.pid";
const MAX_RESPONSE = 16 * 1024 * 1024;

/** One bounded, abortable JSON-RPC exchange with this machine's core. Never starts a core. */
export async function coreRequest<T>(socketPath: string, method: string, params: object, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let done = false;
    const finish = (error?: unknown, result?: T) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal?.reason ?? new Error("Core request aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => finish(new Error(`Core ${method} timed out; inspect state before retrying a mutation`)));
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => { if (!done) finish(new Error(`Core closed before acknowledging ${method}`)); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE) { finish(new Error("Core response is too large")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.jsonrpc !== "2.0" || response.id !== 1 || (!response.error && !("result" in response))) {
          throw new Error(`Invalid core acknowledgment for ${method}`);
        }
        if (response.error) throw new Error(`Core ${method}: ${response.error.message ?? JSON.stringify(response.error)}`);
        finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
  });
}

function isPiProcess(process: ProcessInfo | undefined | null): boolean {
  const argv = process?.argv ?? [];
  return /^pi(?:\.exe)?$/u.test(basename(argv[0] ?? "")) || argv.slice(0, 3).some((arg) =>
    /(?:^|[/\\])pi-coding-agent[/\\].*[/\\]cli\.[cm]?js$/u.test(arg));
}

function sessionPath(process: ProcessInfo | undefined | null): string | undefined {
  const argv = process?.argv ?? [];
  if (!isPiProcess(process)) return;
  for (let i = 1; i < argv.length; i++) {
    const path = argv[i] === "--session" ? argv[i + 1] : argv[i].startsWith("--session=") ? argv[i].slice(10) : undefined;
    // Short IDs cannot safely be resolved as paths, and remote paths are never read locally.
    if (path?.endsWith(".jsonl")) return resolve(process?.cwd || ".", path);
  }
}

/** App agent launches use a foreground sh wrapper. Its live Pi child still owns
 * registration; after that child exits, stale labels must not claim the shell. */
export function livePiChild(pid: number, ancestor: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ancestor) || ancestor <= 0) return false;
  try {
    if (!isPiProcess({ argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) })) return false;
    let current = pid;
    for (let depth = 0; depth < 32; depth++) {
      if (current === ancestor) return true;
      const stat = readFileSync(`/proc/${current}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
      if (!Number.isSafeInteger(parent) || parent <= 1 || parent === current) return false;
      current = parent;
    }
  } catch { /* Process exited or /proc is unavailable: never trust stale labels. */ }
  return false;
}

export function corePane(terminal: CoreTerminal): CorePane | undefined {
  // The transcript store and mailbox are local. Identical paths on another machine are NOT identities.
  if (!/^t[0-9a-z]+$/u.test(terminal.address) || terminal.state !== "live") return;
  const labels = terminal.labels ?? {};
  const registered = labels[PATH_LABEL] && labels[ID_LABEL] && labels[PID_LABEL] &&
    terminal.foreground?.pid !== undefined && (labels[PID_LABEL] === String(terminal.foreground.pid) ||
      livePiChild(Number(labels[PID_LABEL]), terminal.foreground.pid));
  const path = registered ? labels[PATH_LABEL] : sessionPath(terminal.foreground) ??
    // Pi may shorten its foreground process title to just "pi". Its launch argv
    // is a fallback only before registration, never after another PID takes over.
    (!labels[PID_LABEL] && (!terminal.foreground || isPiProcess(terminal.foreground))
      ? sessionPath({ argv: terminal.argv, cwd: terminal.cwd }) : undefined);
  const status = terminal.status?.state;
  return {
    pane_id: terminal.address,
    ...(labels["herdr.space"] ? { workspace_id: labels["herdr.space"] } : {}),
    ...(labels["herdr.tab"] ? { tab_id: labels["herdr.tab"] } : {}),
    ...(path ? {
      agent: "pi",
      agent_status: terminal.status?.app === "pi" && ["idle", "working", "blocked", "done", "error"].includes(status ?? "")
        ? status as CorePane["agent_status"] : "unknown",
      agent_session: { kind: "path", value: path },
    } : {}),
  };
}

/** App/core adapter. The window is optional: remote Pi talks only to its own local core. */
export class CoreSessions {
  constructor(readonly socketPath: string, readonly terminalId: string, private app: AppExec) {}

  async register(sessionId: string, sessionPath: string, signal?: AbortSignal): Promise<void> {
    await coreRequest(this.socketPath, "terminal.label", { terminal: this.terminalId, labels: {
      [PATH_LABEL]: sessionPath, [ID_LABEL]: sessionId, [PID_LABEL]: String(process.pid),
    } }, signal);
  }

  async unregister(sessionPath: string): Promise<void> {
    const signal = AbortSignal.timeout(1000);
    const terminal = await this.terminal(this.terminalId, signal);
    if (terminal.labels[PATH_LABEL] !== sessionPath || terminal.labels[PID_LABEL] !== String(process.pid)) return;
    await coreRequest(this.socketPath, "terminal.label", { terminal: this.terminalId,
      labels: { [PATH_LABEL]: "", [ID_LABEL]: "", [PID_LABEL]: "" } }, signal);
  }

  terminal(address: string, signal?: AbortSignal): Promise<CoreTerminal> {
    if (!/^t[0-9a-z]+$/u.test(address)) throw new Error("pi_sessions core operations target local terminal addresses only");
    return coreRequest(this.socketPath, "terminal.get", { terminal: address }, signal);
  }

  async panes(signal?: AbortSignal): Promise<CorePane[]> {
    const result = await coreRequest<{ terminals: CoreTerminal[] }>(this.socketPath, "terminal.list", {}, signal);
    if (!Array.isArray(result.terminals)) throw new Error("Invalid core terminal list");
    return result.terminals.flatMap((terminal) => { const pane = corePane(terminal); return pane ? [pane] : []; });
  }

  async get(address: string, signal?: AbortSignal): Promise<CorePane> {
    const pane = corePane(await this.terminal(address, signal));
    if (!pane) throw new Error(`Core terminal ${address} is no longer live`);
    return pane;
  }

  async launch(session: Session, argv: string[], signal?: AbortSignal): Promise<CorePane> {
    const parent = await this.terminal(this.terminalId, signal);
    const labels: Record<string, string> = { [PATH_LABEL]: session.sessionPath, [ID_LABEL]: session.sessionId };
    // Herdr adopts labelled terminals as ordinary tabs, even when launched from its remote core.
    if (parent.labels["herdr.space"]) {
      labels["herdr.space"] = parent.labels["herdr.space"];
      labels["herdr.tab"] = `tb${randomUUID().replaceAll("-", "")}`;
    }
    const slug = session.name.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 20) || "pi";
    const terminal = await coreRequest<CoreTerminal>(this.socketPath, "terminal.run", {
      argv, cwd: session.cwd, labels, name: `${slug}-${session.sessionId.replaceAll("-", "").slice(0, 8)}`,
      caller: this.terminalId, parent: this.terminalId, outlive_parent: true, no_notify: true, keep: true,
    }, signal);
    if (!/^t[0-9a-z]+$/u.test(terminal.address)) throw new Error("Core did not return a local terminal address");
    return { pane_id: terminal.address,
      ...(labels["herdr.tab"] ? { tab_id: labels["herdr.tab"], workspace_id: labels["herdr.space"] } : {}),
      agent_session: { kind: "path", value: session.sessionPath } };
  }

  async stop(pane: Pick<CorePane, "pane_id">, sessionPath: string, signal?: AbortSignal): Promise<void> {
    const current = await this.get(pane.pane_id, signal);
    if (current.agent_session?.kind !== "path" || resolve(current.agent_session.value) !== resolve(sessionPath)) {
      throw new Error(`Core terminal ${pane.pane_id} changed sessions; refusing to stop it`);
    }
    // Never close a whole app tab: it may now contain other terminals or mod panes.
    await coreRequest(this.socketPath, "terminal.kill", { terminal: pane.pane_id, caller: this.terminalId }, signal);
  }

  async focus(pane: Pick<CorePane, "pane_id">, signal?: AbortSignal): Promise<void> {
    let result: Awaited<ReturnType<AppExec>>;
    try {
      result = await this.app(["do", "pane.focus", JSON.stringify({ terminal: pane.pane_id })], signal);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Cannot focus ${pane.pane_id} on a connected Herdr App screen. The session remains running; attach with hc if all desktops are offline. ${String(error)}`);
    }
    const response = JSON.parse(result.stdout || "{}");
    if (response.error) throw new Error(`Herdr focus failed: ${JSON.stringify(response.error)}`);
    if (response._routing?.view_errors) throw new Error(`Focused on some screens, but mirroring was incomplete: ${JSON.stringify(response._routing.view_errors)}. The session remains running.`);
  }
}
