import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const METADATA_TYPE = "pi-session-orchestrator";
export const SETTLED_TYPE = "pi-session-run-settled";
export type SessionMetadataReader = Pick<SessionManager, "getHeader" | "getEntries">;
export interface OrchestratorMetadata {
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
}
export type SessionOrigin = "created" | "discovered" | "historical";
export interface ManagedSession {
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
  parentSessionId?: string;
}
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "summary";
  text: string;
  timestamp: number;
  stopReason?: string;
}
export interface SettledRun {
  sessionId: string;
  userEntryId: string;
  assistantEntryId: string;
  outcome: "completed" | "failed" | "aborted";
}
export interface SessionSnapshot {
  session: ManagedSession;
  messages: TranscriptEntry[];
  userEntryIds: Set<string>;
  settled: SettledRun[];
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n").trim();
}

export function metadataFor(manager: SessionMetadataReader): OrchestratorMetadata | undefined {
  const header = manager.getHeader();
  const candidates = manager.getEntries().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== METADATA_TYPE) return [];
    const data = entry.data as OrchestratorMetadata | undefined;
    return data && typeof data.id === "string" && data.id ? [data] : [];
  });
  // Fork/clone copies custom entries. Only the original session owns bound metadata.
  const bound = candidates.findLast((data) => data.sessionId === header?.id);
  if (bound) return bound;
  if (header?.parentSession) return undefined;
  return candidates.findLast((data) => data.sessionId === undefined);
}

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch {
    // New Pi sessions have a filename before their first flush. Preserve a symlinked
    // parent directory's identity so mailbox addresses do not change on that flush.
    try { return join(await realpath(dirname(path)), basename(path)); }
    catch { return resolve(path); }
  }
}

/** Read-only projections, never cached mutable SessionManagers. No disk index to migrate. */
export class SessionStore {
  private cache = new Map<string, { stamp: string; value: SessionSnapshot; bytes: number }>();
  private bytes = 0;
  private catalogue = new Map<string, { stamp: string; session: ManagedSession }>();
  constructor(private root: string) {}

  clear(): void { this.cache.clear(); this.catalogue.clear(); this.bytes = 0; }

  private async stamp(path: string) {
    const info = await stat(path);
    return { info, stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  }

  async load(path: string, signal?: AbortSignal): Promise<SessionSnapshot> {
    signal?.throwIfAborted();
    path = await canonicalPath(path);
    const { info, stamp } = await this.stamp(path); // Never serve deleted or replaced files from cache.
    const previous = this.cache.get(path);
    if (previous?.stamp === stamp) {
      this.cache.delete(path);
      this.cache.set(path, previous);
      return previous.value;
    }
    const entries = parseSessionEntries(await readFile(path, { encoding: "utf8", signal }));
    const sourceHeader = entries[0];
    if (sourceHeader?.type !== "session" || typeof sourceHeader.id !== "string" ||
      typeof sourceHeader.cwd !== "string" || !Number.isFinite(Date.parse(sourceHeader.timestamp))) {
      throw new Error(`Invalid Pi session: ${path}`);
    }
    // inMemory performs legacy migrations in memory; recall never rewrites historical files.
    const manager = SessionManager.inMemory(sourceHeader.cwd, undefined, entries);
    const header = manager.getHeader()!;
    const metadata = metadataFor(manager);
    const branch = manager.getBranch();
    let provider = metadata?.initialProvider;
    let model = metadata?.initialModel;
    let thinking = metadata?.initialThinking;
    const messages: TranscriptEntry[] = [];
    for (const entry of branch) {
      if (entry.type === "model_change") { provider = entry.provider; model = entry.modelId; }
      if (entry.type === "thinking_level_change") thinking = entry.thinkingLevel;
      if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "assistant") { provider = message.provider; model = message.model; }
        if (message.role !== "user" && message.role !== "assistant") continue;
        // Keep empty assistant messages too: tool-use/errors must not look like final answers.
        messages.push({ id: entry.id, role: message.role, text: textContent(message.content),
          timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.parse(entry.timestamp),
          ...(message.role === "assistant" ? { stopReason: message.stopReason } : {}) });
      } else if (entry.type === "compaction" || entry.type === "branch_summary") {
        messages.push({ id: entry.id, role: "summary", text: entry.summary, timestamp: Date.parse(entry.timestamp) });
      }
    }
    const settled = branch.flatMap((entry): SettledRun[] => {
      if (entry.type !== "custom" || entry.customType !== SETTLED_TYPE) return [];
      const data = entry.data as SettledRun | undefined;
      return data?.sessionId === header.id && typeof data.userEntryId === "string" &&
        typeof data.assistantEntryId === "string" && ["completed", "failed", "aborted"].includes(data.outcome) ? [data] : [];
    });
    const createdAt = metadata?.createdAt ?? Date.parse(header.timestamp);
    const value: SessionSnapshot = {
      session: { id: metadata?.id ?? header.id, sessionId: header.id, sessionPath: path,
        name: manager.getSessionName() || `${header.cwd || "Pi session"} · ${new Date(createdAt).toISOString()}`,
        cwd: header.cwd, createdAt, updatedAt: info.mtimeMs, provider, model, thinking,
        lifecycle: metadata?.lifecycle === "task" ? "task" : "persistent",
        origin: metadata ? "created" : "historical", orchestrated: Boolean(metadata),
        parentSessionId: metadata?.parentSessionId },
      messages, settled,
      userEntryIds: new Set(messages.filter((entry) => entry.role === "user").map((entry) => entry.id)),
    };
    this.catalogue.set(path, { stamp, session: value.session });
    if (previous) { this.bytes -= previous.bytes; this.cache.delete(path); }
    // Bound retained transcript memory. Large sessions are still searchable, just not cached.
    const bytes = messages.reduce((sum, entry) => sum + entry.text.length * 2 + 160, 0);
    if (bytes <= 32 * 1024 * 1024) {
      this.cache.set(path, { stamp, value, bytes });
      this.bytes += bytes;
      while (this.cache.size > 256 || this.bytes > 32 * 1024 * 1024) {
        const key = this.cache.keys().next().value!;
        this.bytes -= this.cache.get(key)!.bytes;
        this.cache.delete(key);
      }
    }
    return value;
  }

  async *scan(signal?: AbortSignal): AsyncGenerator<SessionSnapshot> {
    for await (const path of this.paths(signal)) {
      try { yield await this.load(path, signal); }
      catch { signal?.throwIfAborted(); /* Deleted/malformed files do not hide healthy sessions. */ }
    }
  }

  async list(signal?: AbortSignal): Promise<ManagedSession[]> {
    const sessions: ManagedSession[] = [];
    for await (const path of this.paths(signal)) {
      try {
        const { stamp } = await this.stamp(path);
        const previous = this.catalogue.get(path);
        sessions.push(previous?.stamp === stamp ? previous.session : (await this.load(path, signal)).session);
      } catch { signal?.throwIfAborted(); }
    }
    return sessions;
  }

  private async *paths(signal?: AbortSignal): AsyncGenerator<string> {
    const seen = new Set<string>();
    let directories;
    try { directories = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const directory of directories) {
      signal?.throwIfAborted();
      if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
      let files;
      try { files = await readdir(join(this.root, directory.name)); } catch { continue; }
      for (const file of files) {
        signal?.throwIfAborted();
        if (!file.endsWith(".jsonl")) continue;
        const path = await canonicalPath(join(this.root, directory.name, file));
        if (seen.has(path)) continue;
        seen.add(path);
        yield path;
      }
    }
    for (const path of this.catalogue.keys()) if (!seen.has(path)) this.catalogue.delete(path);
    for (const [path, cached] of this.cache) {
      if (!seen.has(path)) { this.bytes -= cached.bytes; this.cache.delete(path); }
    }
  }
}
