import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const METADATA_TYPE = "pi-session-orchestrator";
export const SETTLED_TYPE = "pi-session-run-settled";
export const REPORT_TYPE = "pi-session-report";
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
  role: "user" | "assistant" | "report" | "summary";
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

const INDEX_VERSION = 1;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
interface CatalogueEntry { stamp: string; session: ManagedSession }

function validCatalogueEntry(value: unknown, path: string): value is CatalogueEntry {
  if (!value || typeof value !== "object") return false;
  const { stamp, session: s } = value as CatalogueEntry;
  if (typeof stamp !== "string" || !/^\d+:\d+:\d+:[\d.]+:[\d.]+$/.test(stamp) || !s || typeof s !== "object") return false;
  return s.sessionPath === path && resolve(path) === path &&
    [s.id, s.sessionId, s.name, s.cwd].every((field) => typeof field === "string") &&
    Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt) &&
    [s.provider, s.model, s.thinking, s.parentSessionId].every((field) => field === undefined || typeof field === "string") &&
    ["persistent", "task"].includes(s.lifecycle) && ["created", "historical"].includes(s.origin) &&
    typeof s.orchestrated === "boolean";
}

/** Read-only projections; the disposable disk index stores metadata, never transcript bodies. */
export class SessionStore {
  private cache = new Map<string, { stamp: string; value: SessionSnapshot; bytes: number }>();
  private bytes = 0;
  private catalogue = new Map<string, CatalogueEntry>();
  private indexLoaded?: Promise<void>;
  private indexSave: Promise<void> = Promise.resolve();
  private revision = 0;
  private savedRevision = 0;
  private indexPath: string | null;
  constructor(private root: string, indexPath?: string | null) {
    this.indexPath = indexPath === undefined ? join(homedir(), ".cache", "pi-sessions",
      `${createHash("sha256").update(resolve(root)).digest("hex")}.json`) : indexPath;
  }

  clear(): void {
    this.cache.clear(); this.catalogue.clear(); this.bytes = 0;
    this.revision++;
    // An explicit clear forces the next scan to rebuild rather than rehydrate.
    this.indexLoaded = Promise.resolve();
  }

  private ensureIndex(): Promise<void> {
    return this.indexLoaded ??= (async () => {
      if (!this.indexPath) return;
      try {
        if ((await stat(this.indexPath)).size > MAX_INDEX_BYTES) return;
        const index = JSON.parse(await readFile(this.indexPath, "utf8"));
        if (index.version !== INDEX_VERSION || index.root !== resolve(this.root) || !Array.isArray(index.entries)) return;
        for (const entry of index.entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
            !validCatalogueEntry(entry[1], entry[0])) continue;
          // A direct load may already have obtained fresher metadata.
          if (!this.catalogue.has(entry[0])) {
            const value: CatalogueEntry = entry[1];
            // JSON omits undefined properties; keep the same projection shape
            // as load() for callers comparing cached and freshly read metadata.
            value.session = { ...value.session, provider: value.session.provider,
              model: value.session.model, thinking: value.session.thinking,
              parentSessionId: value.session.parentSessionId };
            this.catalogue.set(entry[0], value);
          }
        }
      } catch { /* Missing, corrupt, or inaccessible indexes are disposable. */ }
    })();
  }

  private saveIndex(): Promise<void> {
    // Serialize writes within this store. Across processes, atomic rename plus
    // per-file stamp validation makes an older winning index safe to reuse.
    return this.indexSave = this.indexSave.then(async () => {
      if (!this.indexPath || this.revision === this.savedRevision) return;
      const revision = this.revision;
      const content = JSON.stringify({ version: INDEX_VERSION, root: resolve(this.root), entries: [...this.catalogue] });
      if (Buffer.byteLength(content) > MAX_INDEX_BYTES) return;
      const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.indexPath);
        this.savedRevision = revision;
      } catch { /* Cache failures must not prevent session discovery. */ }
      finally { await unlink(temporary).catch(() => {}); }
    });
  }

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
      } else if (entry.type === "custom_message" && entry.customType === REPORT_TYPE) {
        messages.push({ id: entry.id, role: "report", text: textContent(entry.content), timestamp: Date.parse(entry.timestamp) });
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
    this.revision++;
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

  async *scan(signal?: AbortSignal, filter?: (session: ManagedSession) => boolean): AsyncGenerator<SessionSnapshot> {
    if (filter) await this.ensureIndex();
    for await (const path of this.paths(signal)) {
      try {
        if (filter) {
          const { stamp } = await this.stamp(path);
          const previous = this.catalogue.get(path);
          if (previous?.stamp === stamp && !filter(previous.session)) continue;
        }
        // On a cold index, parse each file once rather than first building a
        // complete list and then loading eligible transcripts a second time.
        const snapshot = await this.load(path, signal);
        if (!filter || filter(snapshot.session)) yield snapshot;
      } catch { signal?.throwIfAborted(); /* Deleted/malformed files do not hide healthy sessions. */ }
    }
    if (filter) {
      signal?.throwIfAborted();
      await this.saveIndex();
    }
  }

  async list(signal?: AbortSignal): Promise<ManagedSession[]> {
    await this.ensureIndex();
    signal?.throwIfAborted();
    const sessions: ManagedSession[] = [];
    for await (const path of this.paths(signal)) {
      try {
        const { stamp } = await this.stamp(path);
        const previous = this.catalogue.get(path);
        sessions.push(previous?.stamp === stamp ? previous.session : (await this.load(path, signal)).session);
      } catch { signal?.throwIfAborted(); }
    }
    signal?.throwIfAborted();
    await this.saveIndex();
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
    for (const path of this.catalogue.keys()) if (!seen.has(path)) {
      this.catalogue.delete(path);
      this.revision++;
    }
    for (const [path, cached] of this.cache) {
      if (!seen.has(path)) { this.bytes -= cached.bytes; this.cache.delete(path); }
    }
  }
}
