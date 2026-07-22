import { StringEnum } from "@earendil-works/pi-ai";
import {
  SessionManager,
  getAgentDir,
  type ExtensionAPI,
  type SessionInfo,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TOOL_NAME = "pi_sessions";
const METADATA_TYPE = "pi-session-orchestrator";
const LEGACY_REGISTRY_PATH = join(getAgentDir(), "pi-session-orchestrator", "registry.json");
const WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const SIDE_SOURCE_SESSION = process.env.PI_HERDR_SIDE_SOURCE;
const SIDE_PARENT_PANE = process.env.PI_HERDR_SIDE_PARENT_PANE;

const SessionLifecycle = StringEnum(["persistent", "task"] as const);
const ThinkingLevel = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const Action = StringEnum([
  "create",
  "list",
  "status",
  "read",
  "send",
  "watch",
  "focus",
  "stop",
  "resume",
  "rename",
] as const);

type ActionName =
  | "create"
  | "list"
  | "status"
  | "read"
  | "send"
  | "watch"
  | "focus"
  | "stop"
  | "resume"
  | "rename";

interface OrchestratorMetadata {
  version?: number;
  id: string;
  sessionId?: string;
  createdAt?: number;
  createdBy?: string;
  initialProvider?: string;
  initialModel?: string;
  initialThinking?: string;
  lifecycle?: "persistent" | "task";
  parentSessionId?: string;
  delegationDepth?: number;
  // Legacy metadata included name. It is deliberately ignored: session_info is authoritative.
  name?: string;
}

type SessionOrigin = "created" | "discovered" | "historical";

interface ManagedSession {
  id: string;
  name: string;
  sessionPath: string;
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  thinking?: string;
  lifecycle: "persistent" | "task";
  origin: SessionOrigin;
  orchestrated: boolean;
}

interface HerdrAgentSession {
  kind?: "id" | "path" | string;
  value?: string;
}

interface HerdrPane {
  pane_id: string;
  agent?: string;
  agent_status?: "idle" | "working" | "blocked" | "done" | "unknown";
  workspace_id?: string;
  tab_id?: string;
  agent_session?: HerdrAgentSession | null;
}

interface HerdrProcessInfo {
  pane_id?: string;
  foreground_processes?: Array<{
    argv?: string[] | null;
    cwd?: string | null;
  }>;
}

interface HerdrResponse {
  result?: {
    pane?: HerdrPane;
    root_pane?: HerdrPane;
    tab?: { tab_id: string };
    snapshot?: { panes?: HerdrPane[] };
    process_info?: HerdrProcessInfo;
  };
  error?: { message?: string };
}

interface ToolParams {
  action: ActionName;
  id?: string;
  name?: string;
  message?: string;
  cwd?: string;
  timeoutSeconds?: number;
  limit?: number;
  lifecycle?: "persistent" | "task";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  createdAfter?: string;
  updatedAfter?: string;
}

interface LegacySession {
  id?: unknown;
  name?: unknown;
  sessionPath?: unknown;
  createdAt?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
}

interface RuntimeIndex {
  byPath: Map<string, HerdrPane[]>;
  bySessionId: Map<string, HerdrPane[]>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      );
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseDateFilter(value: string | undefined, field: string): number | undefined {
  if (!value?.trim()) return undefined;
  const input = value.trim().toLocaleLowerCase();
  const relative = input.match(/^(\d+)\s*(m|h|d|w)(?:\s+ago)?$/u);
  if (relative) {
    const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
    return Date.now() - Number(relative[1]) * units[relative[2] as keyof typeof units];
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${field} must be an ISO date/time or relative duration such as 3d or 2w`);
  return parsed;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function toolResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function isMetadata(value: unknown): value is OrchestratorMetadata {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    (value as { id: string }).id.length > 0
  );
}

function metadataFor(manager: SessionManager): OrchestratorMetadata | undefined {
  const header = manager.getHeader();
  const candidates = manager.getEntries().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== METADATA_TYPE || !isMetadata(entry.data)) return [];
    return [entry.data];
  });

  // v2 metadata binds itself to its original session. This prevents /fork and /clone,
  // which copy custom entries, from creating a second orchestrated record with the same ID.
  const bound = candidates.findLast((data) => data.sessionId === header?.id);
  if (bound) return bound;
  if (header?.parentSession) return undefined;
  return candidates.findLast((data) => data.sessionId === undefined);
}

function managedFromInfo(info: SessionInfo): ManagedSession | undefined {
  try {
    const manager = SessionManager.open(info.path);
    const metadata = metadataFor(manager);
    const header = manager.getHeader();
    if (!header) return undefined;
    const context = manager.buildSessionContext();
    const thinkingEntry = manager.getBranch().findLast((entry) => entry.type === "thinking_level_change");
    const createdAt = metadata?.createdAt ?? new Date(header.timestamp).getTime();
    const fallbackName = `${info.cwd || header.cwd || "Pi session"} · ${new Date(createdAt).toLocaleString()}`;
    return {
      id: metadata?.id ?? header.id,
      name: manager.getSessionName() || info.name || metadata?.name || fallbackName,
      sessionPath: info.path,
      sessionId: header.id,
      cwd: header.cwd || info.cwd,
      createdAt,
      updatedAt: info.modified.getTime(),
      provider: context.model?.provider ?? metadata?.initialProvider,
      model: context.model?.modelId ?? metadata?.initialModel,
      thinking: thinkingEntry?.thinkingLevel ?? metadata?.initialThinking,
      lifecycle: metadata?.lifecycle === "task" ? "task" : "persistent",
      origin: metadata ? "created" : "historical",
      orchestrated: Boolean(metadata),
    };
  } catch {
    return undefined;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function addRuntime(map: Map<string, HerdrPane[]>, key: string, pane: HerdrPane): void {
  const current = map.get(key) ?? [];
  if (!current.some((item) => item.pane_id === pane.pane_id)) current.push(pane);
  map.set(key, current);
}

function sessionArgument(processInfo: HerdrProcessInfo | undefined): string | undefined {
  for (const process of processInfo?.foreground_processes ?? []) {
    const argv = process.argv ?? [];
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index];
      if (argument === "--session" && argv[index + 1]) {
        return resolve(process.cwd || ".", argv[index + 1]);
      }
      if (argument.startsWith("--session=") && argument.length > 10) {
        return resolve(process.cwd || ".", argument.slice(10));
      }
    }
  }
  return undefined;
}

export default function piSessionOrchestrator(pi: ExtensionAPI) {
  let migrationPromise: Promise<void> | undefined;
  let currentSessionPath: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentSessionPath = ctx.sessionManager.getSessionFile();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const metadata = metadataFor(ctx.sessionManager);
    if (!metadata || metadata.createdBy !== TOOL_NAME) return;
    const depth = Math.max(1, metadata.delegationDepth ?? 1);
    return {
      systemPrompt: `${event.systemPrompt}\n\nOrchestration: this session owns its assigned task (delegation depth ${depth}); work primarily here, and delegate only clearly separable subtasks—not the whole assignment.`,
    };
  });

  async function herdr(args: string[], signal?: AbortSignal): Promise<HerdrResponse> {
    const result = await pi.exec("herdr", args, { timeout: 30_000, signal });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `herdr ${args.join(" ")} failed`);
    }
    const output = result.stdout.trim();
    if (!output) return {};
    try {
      const parsed = JSON.parse(output) as HerdrResponse;
      if (parsed.error) throw new Error(parsed.error.message || "Herdr command failed");
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON from herdr ${args.slice(0, 2).join(" ")}: ${output}`);
      }
      throw error;
    }
  }

  async function migrateLegacyRegistry(): Promise<void> {
    let parsed: { version?: unknown; sessions?: unknown };
    try {
      parsed = JSON.parse(await readFile(LEGACY_REGISTRY_PATH, "utf8")) as typeof parsed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new Error(`Cannot read legacy pi_sessions registry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      throw new Error("Cannot migrate unsupported pi_sessions registry format");
    }

    await withFileMutationQueue(LEGACY_REGISTRY_PATH, async () => {
      for (const legacy of Object.values(parsed.sessions as Record<string, LegacySession>)) {
        if (typeof legacy.sessionPath !== "string" || typeof legacy.id !== "string") continue;
        let manager: SessionManager;
        try {
          manager = SessionManager.open(legacy.sessionPath);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (metadataFor(manager)) continue;

        // Only legacy records whose session file still exists are migrated. The custom
        // entry becomes the sole durable marker; stale registry-only records disappear.
        const legacyPath = legacy.sessionPath;
        const legacyId = legacy.id;
        await withFileMutationQueue(legacyPath, async () => {
          const current = SessionManager.open(legacyPath);
          if (metadataFor(current)) return;
          current.appendCustomEntry(METADATA_TYPE, {
            version: 2,
            id: legacyId,
            sessionId: current.getSessionId(),
            createdAt: typeof legacy.createdAt === "number" ? legacy.createdAt : undefined,
            createdBy: TOOL_NAME,
            initialProvider: typeof legacy.provider === "string" ? legacy.provider : undefined,
            initialModel: typeof legacy.model === "string" ? legacy.model : undefined,
            initialThinking: typeof legacy.thinking === "string" ? legacy.thinking : undefined,
          } satisfies OrchestratorMetadata);
        });
      }

      await unlink(LEGACY_REGISTRY_PATH);
      await rmdir(dirname(LEGACY_REGISTRY_PATH)).catch((error) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOTEMPTY") throw error;
      });
    });
  }

  async function ensureMigrated(): Promise<void> {
    migrationPromise ??= migrateLegacyRegistry();
    return migrationPromise;
  }

  async function discoverSessions(): Promise<ManagedSession[]> {
    await ensureMigrated();
    const infos = await SessionManager.listAll();
    const byIdentity = new Map<string, ManagedSession>();
    for (const info of infos) {
      const session = managedFromInfo(info);
      if (!session) continue;
      const key = `${session.sessionId}\0${await canonicalPath(session.sessionPath)}`;
      const previous = byIdentity.get(key);
      if (!previous || session.updatedAt > previous.updatedAt) byIdentity.set(key, session);
    }
    return [...byIdentity.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function ambiguous(needle: string, candidates: ManagedSession[]): never {
    const rows = candidates.slice(0, 12).map((session) =>
      `${session.id}  ${session.name}  ${session.cwd}  updated ${new Date(session.updatedAt).toISOString()}`,
    );
    throw new Error(`Ambiguous Pi session query: ${needle}\n${rows.join("\n")}`);
  }

  async function resolveSession(idOrName: string | undefined): Promise<ManagedSession> {
    if (!idOrName?.trim()) throw new Error("This action requires a session ID, prefix, path, pane ID, or name");
    const needle = idOrName.trim();
    const folded = needle.toLocaleLowerCase();
    const sessions = await discoverSessions();
    const runtimeIndex = await discoverRuntimes();

    if (needle === "current" || needle === "self" || (needle === "main" && !SIDE_SOURCE_SESSION)) {
      const current = sessions.filter((session) => currentSessionPath && resolve(session.sessionPath) === resolve(currentSessionPath));
      if (current.length === 1) return current[0];
      throw new Error("The current Pi session is not persistent or could not be discovered");
    }
    if ((needle === "main" || needle === "parent") && SIDE_SOURCE_SESSION) {
      const source = sessions.filter((session) => resolve(session.sessionPath) === resolve(SIDE_SOURCE_SESSION));
      if (source.length === 1) return source[0];
      throw new Error("The side chat's source session is unavailable");
    }

    const runtimeNeedle = needle === "parent" && SIDE_PARENT_PANE ? SIDE_PARENT_PANE : needle;
    const paneMatches: ManagedSession[] = [];
    for (const session of sessions) {
      const panes = await runtimesFor(session, undefined, runtimeIndex);
      if (panes.some((pane) => pane.pane_id === runtimeNeedle)) paneMatches.push(session);
    }
    if (paneMatches.length === 1) return paneMatches[0];
    if (paneMatches.length > 1) ambiguous(needle, paneMatches);

    const exact = sessions.filter((session) =>
      session.id === needle || session.sessionId === needle || session.sessionPath === needle || session.name.toLocaleLowerCase() === folded,
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) ambiguous(needle, exact);

    const prefixes = sessions.filter((session) => session.id.startsWith(needle) || session.sessionId.startsWith(needle));
    if (prefixes.length === 1) return prefixes[0];
    if (prefixes.length > 1) ambiguous(needle, prefixes);

    const fuzzy = sessions.filter((session) =>
      session.name.toLocaleLowerCase().includes(folded) || session.cwd.toLocaleLowerCase().includes(folded),
    );
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) ambiguous(needle, fuzzy);
    throw new Error(`Unknown Pi session: ${needle}`);
  }

  async function discoverRuntimes(signal?: AbortSignal): Promise<RuntimeIndex> {
    const index: RuntimeIndex = { byPath: new Map(), bySessionId: new Map() };
    if (process.env.HERDR_ENV !== "1") return index;

    const response = await herdr(["api", "snapshot"], signal);
    const panes = response.result?.snapshot?.panes ?? [];
    for (const pane of panes) {
      const reference = pane.agent_session;
      if (reference?.kind === "path" && reference.value) {
        addRuntime(index.byPath, await canonicalPath(reference.value), pane);
      } else if (reference?.kind === "id" && reference.value) {
        addRuntime(index.bySessionId, reference.value, pane);
      }
    }

    // Native Herdr session metadata is authoritative. Process arguments are a safe
    // compatibility fallback for runtimes that have not loaded Herdr's Pi integration.
    for (const pane of panes) {
      if (pane.agent !== "pi" || pane.agent_session) continue;
      try {
        const processResponse = await herdr(["pane", "process-info", "--pane", pane.pane_id], signal);
        const path = sessionArgument(processResponse.result?.process_info);
        if (path) addRuntime(index.byPath, await canonicalPath(path), pane);
      } catch {
        // A pane can exit while the snapshot is being inspected.
      }
    }
    return index;
  }

  async function runtimesFor(
    session: ManagedSession,
    signal?: AbortSignal,
    runtimeIndex?: RuntimeIndex,
  ): Promise<HerdrPane[]> {
    const index = runtimeIndex ?? (await discoverRuntimes(signal));
    const pathMatches = index.byPath.get(await canonicalPath(session.sessionPath)) ?? [];
    const idMatches = index.bySessionId.get(session.sessionId) ?? [];
    const combined = [...pathMatches];
    for (const pane of idMatches) {
      if (!combined.some((item) => item.pane_id === pane.pane_id)) combined.push(pane);
    }
    return combined;
  }

  async function oneRuntime(session: ManagedSession, signal?: AbortSignal): Promise<HerdrPane | null> {
    const runtimes = await runtimesFor(session, signal);
    if (runtimes.length > 1) {
      throw new Error(`Session ${session.id} is open in multiple Herdr panes; stop the duplicate runtime first`);
    }
    return runtimes[0] ?? null;
  }

  function runtimeStatus(runtimes: HerdrPane[]): string {
    if (runtimes.length === 0) return "stopped";
    const statuses = [...new Set(runtimes.map((pane) => pane.agent_status ?? "unknown"))];
    return statuses.length === 1 ? statuses[0] : "multiple";
  }

  function effectiveOrigin(session: ManagedSession, runtimes: HerdrPane[]): SessionOrigin {
    return session.orchestrated ? "created" : runtimes.length > 0 ? "discovered" : "historical";
  }

  function assertNotSelf(session: ManagedSession, action: string): void {
    if (currentSessionPath && resolve(session.sessionPath) === resolve(currentSessionPath)) {
      throw new Error(`Cannot ${action} the current Pi session through pi_sessions`);
    }
  }

  function latestMessage(session: ManagedSession, role: "user" | "assistant"): { text: string; timestamp: number } | null {
    const branch = SessionManager.open(session.sessionPath).getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "message" || entry.message.role !== role) continue;
      const text = textContent(entry.message.content);
      if (text) return { text, timestamp: entry.message.timestamp };
    }
    return null;
  }

  function recentConversation(session: ManagedSession, limit: number): string {
    const lines: string[] = [];
    for (const entry of SessionManager.open(session.sessionPath).getBranch()) {
      if (entry.type !== "message") continue;
      if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
      const text = textContent(entry.message.content);
      if (text) lines.push(`${entry.message.role === "user" ? "User" : "Assistant"}: ${text}`);
    }
    return lines.slice(-limit).join("\n\n") || "(No user/assistant messages yet.)";
  }

  function launchCommand(session: ManagedSession): string {
    return [
      "pi",
      `--session ${shellQuote(session.sessionPath)}`,
      session.provider ? `--provider ${shellQuote(session.provider)}` : "",
      session.model ? `--model ${shellQuote(session.model)}` : "",
      session.thinking ? `--thinking ${shellQuote(session.thinking)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  async function waitUntilReady(paneId: string, signal?: AbortSignal): Promise<HerdrPane> {
    const deadline = Date.now() + 30_000;
    let readySince: number | undefined;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const response = await herdr(["pane", "get", paneId], signal);
      const pane = response.result?.pane;
      const ready = pane?.agent === "pi" && (pane.agent_status === "idle" || pane.agent_status === "done");
      if (ready) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= 1_000) return pane;
      } else {
        readySince = undefined;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error("Timed out waiting for the Pi session to become ready");
  }

  function sessionContainsUserMessage(session: ManagedSession, message: string): boolean {
    try {
      return SessionManager.open(session.sessionPath)
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            textContent(entry.message.content) === message,
        );
    } catch {
      return false;
    }
  }

  async function waitUntilPromptAccepted(
    session: ManagedSession,
    paneId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const waitForMessage = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (sessionContainsUserMessage(session, message)) return true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
      return false;
    };
    if (await waitForMessage(5_000)) return;
    await herdr(["pane", "send-keys", paneId, "enter"], signal);
    if (await waitForMessage(5_000)) return;
    throw new Error("Pi did not accept the session prompt");
  }

  async function launchSession(
    session: ManagedSession,
    signal?: AbortSignal,
  ): Promise<{ session: ManagedSession; runtime: HerdrPane }> {
    if (process.env.HERDR_ENV !== "1" || !WORKSPACE_ID) {
      throw new Error("pi_sessions requires Pi to run inside Herdr");
    }
    const existing = await oneRuntime(session, signal);
    if (existing) return { session, runtime: existing };

    const response = await herdr(
      [
        "tab",
        "create",
        "--workspace",
        WORKSPACE_ID,
        "--cwd",
        session.cwd,
        "--label",
        session.name,
        "--no-focus",
      ],
      signal,
    );
    const tabId = response.result?.tab?.tab_id;
    const paneId = response.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new Error("Herdr did not return a tab and pane ID");

    try {
      await herdr(["pane", "run", paneId, launchCommand(session)], signal);
      const runtime = await waitUntilReady(paneId, signal);
      return { session: (await resolveSession(session.id)), runtime: { ...runtime, tab_id: runtime.tab_id ?? tabId } };
    } catch (error) {
      await herdr(["tab", "close", tabId]).catch(() => {});
      throw error;
    }
  }

  async function sendPrompt(session: ManagedSession, message: string, signal?: AbortSignal): Promise<ManagedSession> {
    assertNotSelf(session, "send to");
    const existing = await oneRuntime(session, signal);
    if (existing && !session.orchestrated) {
      throw new Error(`Refusing to send to discovered session ${session.id}: Pi cannot verify that its editor draft is empty. Focus it or use the side-chat mailbox handoff instead.`);
    }
    const launched = existing ? { session, runtime: existing } : await launchSession(session, signal);
    const pane = launched.runtime;
    if (pane.agent_status === "working" || pane.agent_status === "blocked") {
      throw new Error(`Session ${session.id} is ${pane.agent_status}; wait for it before sending another message`);
    }
    await herdr(["pane", "run", pane.pane_id, message], signal);
    await waitUntilPromptAccepted(launched.session, pane.pane_id, message, signal);
    return resolveSession(session.id);
  }

  async function closeRuntimeTabs(runtimes: HerdrPane[], signal?: AbortSignal): Promise<void> {
    const tabIds = [...new Set(runtimes.map((runtime) => runtime.tab_id).filter((id): id is string => Boolean(id)))];
    for (const tabId of tabIds) await herdr(["tab", "close", tabId], signal);
    for (const runtime of runtimes.filter((pane) => !pane.tab_id)) {
      await herdr(["pane", "close", runtime.pane_id], signal);
    }
  }

  async function monitorTaskCompletion(sessionId: string): Promise<void> {
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const current = await resolveSession(sessionId);
      if (current.lifecycle !== "task") return;
      const runtimes = await runtimesFor(current);
      const status = runtimeStatus(runtimes);
      const latest = latestMessage(current, "assistant");
      const latestUser = latestMessage(current, "user");
      if (latest && latestUser && latest.timestamp >= latestUser.timestamp && (status === "idle" || status === "done")) {
        await closeRuntimeTabs(runtimes);
        return;
      }
      if (status === "stopped" || status === "multiple") return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }

  async function createSession(
    params: ToolParams,
    ctx: { cwd: string; model?: { provider: string; id: string } | null; sessionManager?: SessionManager },
    signal?: AbortSignal,
  ): Promise<ManagedSession> {
    const name = params.name?.trim();
    const message = params.message?.trim();
    if (!name) throw new Error("create requires name");
    if (!message) throw new Error("create requires message");
    await ensureMigrated();

    const cwd = resolve(params.cwd?.trim() || ctx.cwd);
    const manager = SessionManager.create(cwd);
    const sessionId = manager.getSessionId();
    const id = `dir_${sessionId.replace(/-/g, "")}`;
    const createdAt = Date.now();
    manager.appendSessionInfo(name);
    const parentHeader = ctx.sessionManager?.getHeader();
    const parentMetadata = ctx.sessionManager ? metadataFor(ctx.sessionManager) : undefined;
    manager.appendCustomEntry(METADATA_TYPE, {
      version: 4,
      id,
      sessionId,
      createdAt,
      createdBy: TOOL_NAME,
      initialProvider: ctx.model?.provider,
      initialModel: ctx.model?.id,
      initialThinking: params.thinking ?? pi.getThinkingLevel(),
      lifecycle: params.lifecycle === "task" ? "task" : "persistent",
      parentSessionId: parentHeader?.id,
      delegationDepth: Math.max(0, parentMetadata?.delegationDepth ?? 0) + 1,
    } satisfies OrchestratorMetadata);
    const sessionPath = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionPath || !header) throw new Error("Pi did not create a persistent session file");

    // SessionManager delays its first write until an assistant message. The runtime
    // needs the path now, so atomically create the normal JSONL snapshot ourselves.
    await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
    await writeFile(
      sessionPath,
      `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );

    const session = await resolveSession(id);
    try {
      return await sendPrompt(session, message, signal);
    } catch (error) {
      throw new Error(
        `Created ${id} at ${sessionPath}, but failed to launch or send its starting message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Pi Sessions",
    description:
      "Discover and manage local Pi sessions, including orchestrator-created workers, active external Herdr sessions, and inactive historical sessions on disk. New sessions receive only their explicit starting message plus normal project context; they do not inherit this conversation. Reserve creation for explicit requests, clean-room review, or substantial independent work—not routine inspect-edit-test workflows, small fixes, or tightly coupled side-chat work. Ambiguous lookups are rejected with candidates, and unsafe cross-session operations are blocked.",
    promptSnippet: "Discover and safely manage local Pi sessions",
    promptGuidelines: [
      "Use pi_sessions to discover or manage existing local Pi sessions when requested; session creation should remain exceptional.",
      "Create a subagent session only for substantial independent work or a deliberately clean-room perspective. A session already created to own an assigned task should work primarily there and delegate only clearly separable subtasks, not pass through the whole assignment. Do not delegate routine inspect-edit-test workflows, simple fixes, tightly coupled work, or merely because delegation is available—especially from an ephemeral side chat. If uncertain, work in the current session or ask the user first.",
      "When creating with pi_sessions, make the starting message self-contained because the new session does not inherit the current conversation.",
      "Use lifecycle=task for sessions acting as internal subagents; use persistent only when the user wants to keep or revisit the session tab.",
      "Treat a created pi_sessions worker as blocking when its result is needed for the current request: watch it to completion, inspect and validate its result, and continue dependent work in the same turn. Leave it running only when the user explicitly asks for background work; after a watch timeout, inspect status and output before responding.",
    ],
    parameters: Type.Object({
      action: Action,
      id: Type.Optional(Type.String({ description: "Session ID/prefix, path, pane ID, exact/fuzzy name, cwd fragment, or current/self alias" })),
      name: Type.Optional(Type.String({ description: "Session name for create or rename" })),
      message: Type.Optional(Type.String({ description: "Starting message for create or follow-up for send" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for create, or cwd substring filter for list" })),
      createdAfter: Type.Optional(Type.String({ description: "List sessions created after ISO date/time or relative duration (for example 3d)" })),
      updatedAfter: Type.Optional(Type.String({ description: "List sessions updated after ISO date/time or relative duration (for example 2w)" })),
      lifecycle: Type.Optional(SessionLifecycle),
      thinking: Type.Optional(ThinkingLevel),
      timeoutSeconds: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 3600, description: "Watch timeout; default 300" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Conversation messages to return from read; default 20" }),
      ),
    }),
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
      switch (params.action) {
        case "create": {
          const session = await createSession(params, ctx, signal);
          const runtime = await oneRuntime(session, signal);
          if (session.lifecycle === "task") {
            void monitorTaskCompletion(session.id).catch(() => {});
          }
          return toolResult(
            `Created ${session.id} (${session.name})\nLifecycle: ${session.lifecycle}\nSession: ${session.sessionPath}\nHerdr tab: ${runtime?.tab_id ?? "running"}\nStarting message sent.`,
            { session, runtime },
          );
        }
        case "list": {
          const [allSessions, runtimeIndex] = await Promise.all([discoverSessions(), discoverRuntimes(signal)]);
          const createdAfter = parseDateFilter(params.createdAfter, "createdAfter");
          const updatedAfter = parseDateFilter(params.updatedAfter, "updatedAfter");
          const cwdFilter = params.cwd?.trim().toLocaleLowerCase();
          const sessions = allSessions.filter((session) =>
            (!cwdFilter || session.cwd.toLocaleLowerCase().includes(cwdFilter)) &&
            (createdAfter === undefined || session.createdAt >= createdAfter) &&
            (updatedAfter === undefined || session.updatedAt >= updatedAfter),
          );
          if (sessions.length === 0) return toolResult("No local Pi sessions matched.", { sessions: [] });
          const rows: string[] = [];
          const details = [];
          for (const session of sessions) {
            const runtimes = await runtimesFor(session, signal, runtimeIndex);
            const status = runtimeStatus(runtimes);
            const origin = effectiveOrigin(session, runtimes);
            rows.push(`${session.id}  ${origin.padEnd(10)}  ${status.padEnd(8)}  ${session.name}  (${formatAge(session.updatedAt)} ago)`);
            details.push({ ...session, origin, status, runtimes });
          }
          return toolResult(rows.join("\n"), { sessions: details });
        }
        case "status": {
          const session = await resolveSession(params.id);
          const runtimes = await runtimesFor(session, signal);
          const status = runtimeStatus(runtimes);
          const latest = latestMessage(session, "assistant");
          return toolResult(
            [
              `${session.id} (${session.name})`,
              `Origin: ${effectiveOrigin(session, runtimes)}`,
              `Status: ${status}`,
              `Session: ${session.sessionPath}`,
              runtimes.length ? `Herdr pane: ${runtimes.map((pane) => pane.pane_id).join(", ")}` : "Herdr pane: stopped",
              latest ? `Latest assistant: ${latest.text}` : "Latest assistant: (none)",
            ].join("\n"),
            { session, status, runtimes, latest },
          );
        }
        case "read": {
          const session = await resolveSession(params.id);
          const limit = Math.max(1, Math.min(100, params.limit ?? 20));
          return toolResult(recentConversation(session, limit), { session, limit });
        }
        case "send": {
          const message = params.message?.trim();
          if (!message) throw new Error("send requires message");
          const session = await resolveSession(params.id);
          const updated = await sendPrompt(session, message, signal);
          return toolResult(`Sent follow-up to ${updated.id} (${updated.name}).`, { session: updated });
        }
        case "watch": {
          const session = await resolveSession(params.id);
          const timeoutMs = Math.max(1, Math.min(3600, params.timeoutSeconds ?? 300)) * 1000;
          const deadline = Date.now() + timeoutMs;
          let previousStatus = "";
          while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Watch aborted");
            const current = await resolveSession(session.id);
            const runtimes = await runtimesFor(current, signal);
            const status = runtimeStatus(runtimes);
            const latest = latestMessage(current, "assistant");
            const latestUser = latestMessage(current, "user");
            if (status !== previousStatus) {
              previousStatus = status;
              onUpdate?.(toolResult(`Watching ${current.id}: ${status}`, { session: current, status, runtimes, latest }));
            }
            if (latest && latestUser && latest.timestamp >= latestUser.timestamp && (status === "idle" || status === "done")) {
              const cleanedUp = current.lifecycle === "task";
              if (cleanedUp) await closeRuntimeTabs(runtimes, signal).catch(() => {});
              return toolResult(
                `Completed ${current.id} (${current.name})${cleanedUp ? "\nHerdr task tab closed; session file preserved." : ""}\n\n${latest.text}`,
                {
                  session: current,
                  status,
                  runtimes,
                  latest,
                  cleanedUp,
                },
              );
            }
            if (status === "blocked") {
              return toolResult(`${current.id} (${current.name}) is blocked and needs input.`, {
                session: current,
                status,
                runtimes,
                latest,
              });
            }
            if (status === "stopped") {
              return toolResult(`${current.id} (${current.name}) is historical/stopped.${latest ? `\n\n${latest.text}` : ""}`, {
                session: current,
                status,
                runtimes,
                latest,
              });
            }
            if (status === "multiple") throw new Error(`${current.id} is open in multiple Herdr panes`);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          }
          throw new Error(`Timed out waiting for ${session.id}`);
        }
        case "focus": {
          const session = await resolveSession(params.id);
          const { runtime } = await launchSession(session, signal);
          if (!runtime.tab_id) throw new Error("Session has no Herdr tab");
          await herdr(["tab", "focus", runtime.tab_id], signal);
          return toolResult(`Focused ${session.id} (${session.name}).`, { session, runtime });
        }
        case "stop": {
          const session = await resolveSession(params.id);
          assertNotSelf(session, "stop");
          const runtimes = await runtimesFor(session, signal);
          // Orchestrated sessions are launched in dedicated tabs. Closing only the
          // root pane can leave Herdr's tab alive with stale Pi session metadata,
          // causing status/watch to report an idle runtime forever. Close the tab
          // as the lifecycle boundary, with pane close only as a fallback for
          // runtimes that have no tab metadata.
          await closeRuntimeTabs(runtimes, signal);
          return toolResult(`Stopped ${session.id}; session file preserved.`, { session, stoppedRuntimes: runtimes });
        }
        case "resume": {
          const session = await resolveSession(params.id);
          const { session: current, runtime } = await launchSession(session, signal);
          return toolResult(`Running ${current.id} (${current.name}) in Herdr tab ${runtime.tab_id}.`, {
            session: current,
            runtime,
          });
        }
        case "rename": {
          const name = params.name?.trim();
          if (!name) throw new Error("rename requires name");
          const session = await resolveSession(params.id);
          // Renaming the current session is safe and useful. Self-target guards remain
          // in place for send and stop, which can recurse or tear down this runtime.
          const runtime = await oneRuntime(session, signal);
          if (runtime?.agent_status === "working" || runtime?.agent_status === "blocked") {
            throw new Error(`Cannot rename while ${session.id} is ${runtime.agent_status}`);
          }
          if (runtime) {
            await herdr(["pane", "run", runtime.pane_id, `/name ${name}`], signal);
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && SessionManager.open(session.sessionPath).getSessionName() !== name) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
            }
            if (SessionManager.open(session.sessionPath).getSessionName() !== name) {
              throw new Error("Pi did not persist the new session name");
            }
            if (runtime.tab_id) await herdr(["tab", "rename", runtime.tab_id, name], signal);
          } else {
            SessionManager.open(session.sessionPath).appendSessionInfo(name);
          }
          const renamed = await resolveSession(session.id);
          return toolResult(`Renamed ${renamed.id} to ${name}.`, { session: renamed, runtime });
        }
      }
    },
  });
}
