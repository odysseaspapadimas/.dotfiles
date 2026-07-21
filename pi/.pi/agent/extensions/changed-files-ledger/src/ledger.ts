import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const INDEX_VERSION = 3;
const MAX_TURNS = 100;
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_SESSIONS = 20;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const MAX_AUTOMATIC_CHECKPOINTS = 10;
export const NAMED_CHECKPOINT_WARNING_BYTES = 250 * 1024 * 1024;
export interface FileState {
  hash: string;
  kind: "file" | "symlink";
  mode: number;
  size: number;
}

export interface Snapshot {
  createdAt: string;
  files: Record<string, FileState>;
  /** Content address of the persisted gzip manifest. */
  id?: string;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  binary: number;
}

export type TurnKind = "agent" | "restoration";

export interface TurnSource {
  /** Stable Pi session entry/message identifier; absent for synthetic inputs. */
  entryId?: string;
  /** Short normalized text only; full user messages are never cached here. */
  excerpt: string;
}

export interface TurnRecord {
  id: string;
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  before: Snapshot;
  after: Snapshot;
  stats: DiffStats;
  /** User message that caused this run; absent on old or unidentifiable turns. */
  source?: TurnSource;
  /** Missing on version-1/early version-2 records and treated as genuine agent work. */
  kind?: TurnKind;
  restoration?: { target: string; action: RestoreAction; divergenceFiles: number };
}

export type CheckpointKind = "named" | "automatic";

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  /** Present only for named checkpoints and unique within a ledger. */
  name?: string;
  /** Human-readable provenance for automatic restore safety points. */
  sourceLabel?: string;
  /** Technical restoration target retained for diagnostics. */
  sourceId?: string;
  createdAt: string;
  snapshot: Snapshot;
}

export interface CheckpointStorageReport {
  checkpoints: number;
  named: number;
  automatic: number;
  /** Physical bytes uniquely reachable from named checkpoint roots. */
  namedBytes: number;
  warningBytes: number;
  warning: boolean;
}

export interface LedgerIndex {
  version: 3;
  sessionId: string;
  root: string;
  git: boolean;
  createdAt: string;
  updatedAt: string;
  baseline: Snapshot;
  latest: Snapshot;
  /** Per-turn scopes shown by /diff; cleared with the review baseline. */
  reviewTurns: TurnRecord[];
  /** Retained restoration targets/audits, independent of review state. */
  recoveryTurns: TurnRecord[];
  checkpoints: Checkpoint[];
}

export interface RecoveryHistoryReport {
  agentTurns: number;
  restorationAudits: number;
  automaticCheckpoints: number;
  namedCheckpoints: number;
}

export interface Scope {
  id: string;
  label: string;
  before: Snapshot;
  after: Snapshot;
  stats: DiffStats;
}

export type RestoreAction = "after" | "undo" | "checkpoint";

export interface RestoreTarget {
  id: string;
  label: string;
  action: RestoreAction;
  snapshot: Snapshot;
}

export interface RollbackPreview {
  /** Kept for API compatibility; turn targets do not have a checkpoint. */
  checkpoint?: Checkpoint;
  target: RestoreTarget;
  scope: Scope;
  /** Snapshot used to reject a stale preview before any files are changed. */
  current: Snapshot;
  /** Current workspace changes not represented by the ledger's latest snapshot. */
  divergence: DiffStats;
}

export interface RollbackConfirmation {
  confirmed: true;
}

export interface RollbackResult {
  safetyCheckpoint: Checkpoint;
  turn: TurnRecord;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function validateRelativePath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe ledger path: ${JSON.stringify(path)}`);
  }
  return normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else total += (await stat(child).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

async function indexHasNamedCheckpoints(path: string): Promise<boolean> {
  try {
    const index = JSON.parse(await readFile(path, "utf8")) as { checkpoints?: Array<{ kind?: string }> };
    return index.checkpoints?.some((checkpoint) => checkpoint.kind === "named") ?? false;
  } catch {
    return false;
  }
}

export class ChangedFilesLedger {
  readonly cacheRoot: string;
  readonly sessionDir: string;
  readonly blobDir: string;
  readonly snapshotDir: string;
  readonly indexPath: string;
  readonly patchPath: string;
  readonly sessionKey: string;
  root: string;
  isGit = false;
  index: LedgerIndex | undefined;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    readonly sessionId: string,
    cwd: string,
    cacheRoot = join(homedir(), ".cache", "pi-changes-ledger"),
  ) {
    this.cacheRoot = cacheRoot;
    this.sessionKey = safeSessionKey(sessionId);
    this.sessionDir = join(cacheRoot, this.sessionKey);
    this.blobDir = join(this.sessionDir, "blobs");
    this.snapshotDir = join(this.sessionDir, "snapshots");
    this.indexPath = join(this.sessionDir, "index.json");
    this.patchPath = join(this.sessionDir, "selected.patch");
    this.root = resolve(cwd);
  }

  async initialize(): Promise<void> {
    const requestedRoot = this.root;
    const gitRoot = await this.pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: requestedRoot,
      timeout: 2_000,
    });
    if (gitRoot.code !== 0 || !gitRoot.stdout.trim()) {
      const location = requestedRoot === resolve(homedir()) ? "$HOME" : requestedRoot;
      throw new Error(
        `Changed-files ledger disabled: ${location} is not inside a Git worktree. Start Pi in a bounded project directory.`,
      );
    }
    this.root = resolve(gitRoot.stdout.trim());
    this.isGit = true;
    await Promise.all([mkdir(this.blobDir, { recursive: true }), mkdir(this.snapshotDir, { recursive: true })]);

    const restored = await this.loadIndex();
    if (restored && restored.root === this.root && restored.sessionId === this.sessionId) {
      this.index = restored;
      this.index.latest = await this.captureSnapshot();
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
    } else {
      const baseline = await this.captureSnapshot();
      const now = new Date().toISOString();
      this.index = {
        version: INDEX_VERSION,
        sessionId: this.sessionId,
        root: this.root,
        git: this.isGit,
        createdAt: now,
        updatedAt: now,
        baseline,
        latest: baseline,
        reviewTurns: [],
        recoveryTurns: [],
        checkpoints: [],
      };
      await this.saveIndex();
    }
    await this.pruneGlobalCache();
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release: (() => void) | undefined;
    this.operation = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async captureSnapshot(): Promise<Snapshot> {
    if (!this.isGit) throw new Error("Changed-files ledger is not initialized in a Git worktree");
    const paths = await this.gitPaths();
    if (paths.length > MAX_FILES) {
      throw new Error(`Changed-files ledger disabled: project has ${paths.length} candidate files (limit ${MAX_FILES}).`);
    }

    // Complete a metadata-only preflight before reading or storing any content. This
    // prevents one huge file or tree from leaving a partial multi-megabyte cache.
    const candidates: Array<{
      relativePath: string;
      absolutePath: string;
      info: Stats;
      kind: "file" | "symlink";
    }> = [];
    let totalBytes = 0;
    for (const listedPath of paths) {
      const relativePath = validateRelativePath(listedPath);
      const absolutePath = join(this.root, relativePath);
      const info = await lstat(absolutePath).catch(() => undefined);
      if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
      const kind = info.isSymbolicLink() ? "symlink" : "file";
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `Changed-files ledger disabled: ${normalizePath(relativePath)} is ${info.size} bytes (per-file limit ${MAX_FILE_BYTES}).`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`Changed-files ledger disabled: candidate files exceed ${MAX_TOTAL_BYTES} total bytes.`);
      }
      candidates.push({ relativePath, absolutePath, info, kind });
    }

    const files: Record<string, FileState> = {};
    for (const candidate of candidates) {
      const content = candidate.kind === "symlink"
        ? Buffer.from(await readlink(candidate.absolutePath), "utf8")
        : await readFile(candidate.absolutePath);
      const hash = sha256(Buffer.concat([Buffer.from(`${candidate.kind}\0`), content]));
      await this.storeBlob(hash, content);
      files[validateRelativePath(candidate.relativePath)] = {
        hash,
        kind: candidate.kind,
        mode: candidate.info.mode & 0o777,
        size: content.byteLength,
      };
    }
    return this.storeSnapshot({ createdAt: new Date().toISOString(), files });
  }

  async beginTurn(turnIndex: number, timestamp = Date.now(), source?: TurnSource): Promise<{ id: string; turnIndex: number; startedAt: string; before: Snapshot; source?: TurnSource }> {
    return this.exclusive(async () => ({
      id: `${turnIndex}-${timestamp}`,
      turnIndex,
      startedAt: new Date(timestamp).toISOString(),
      before: await this.captureSnapshot(),
      ...(source ? { source } : {}),
    }));
  }

  async refreshLatest(): Promise<Snapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.captureSnapshot();
      if (this.index) this.index.latest = snapshot;
      return snapshot;
    });
  }

  async resetBaseline(): Promise<Snapshot> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const baseline = await this.captureSnapshot();
      this.index.baseline = baseline;
      this.index.latest = baseline;
      this.index.reviewTurns = [];
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      await writeFile(this.patchPath, emptyPatch("Diff history cleared"));
      return baseline;
    });
  }

  async createCheckpoint(kind: CheckpointKind, name?: string): Promise<Checkpoint> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const snapshot = await this.captureSnapshot();
      const checkpoint = this.addCheckpoint(kind, snapshot, name);
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return checkpoint;
    });
  }

  checkpoint(idOrName: string): Checkpoint | undefined {
    return this.index?.checkpoints.find((item) => item.id === idOrName || (item.kind === "named" && item.name === idOrName));
  }

  genuineAgentTurns(): TurnRecord[] {
    return (this.index?.recoveryTurns ?? []).filter((turn) => turn.kind !== "restoration" && !turn.id.startsWith("rollback-") && !turn.id.startsWith("restore-"));
  }

  recoveryHistoryReport(): RecoveryHistoryReport {
    const turns = this.index?.recoveryTurns ?? [];
    const checkpoints = this.index?.checkpoints ?? [];
    return {
      agentTurns: this.genuineAgentTurns().length,
      restorationAudits: turns.length - this.genuineAgentTurns().length,
      automaticCheckpoints: checkpoints.filter((item) => item.kind === "automatic").length,
      namedCheckpoints: checkpoints.filter((item) => item.kind === "named").length,
    };
  }

  async pruneRecoveryHistory(): Promise<RecoveryHistoryReport> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const removed = this.recoveryHistoryReport();
      this.index.recoveryTurns = [];
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return removed;
    });
  }

  async latestEligibleTurn(): Promise<TurnRecord | undefined> {
    const current = await this.captureSnapshot();
    return [...this.genuineAgentTurns()].reverse().find((turn) => changedPaths(current, turn.before).length > 0);
  }

  async previewRestore(target: RestoreTarget): Promise<RollbackPreview> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const current = await this.captureSnapshot();
      const files = changedPaths(current, target.snapshot).length;
      const divergenceFiles = changedPaths(this.index.latest, current).length;
      return {
        target,
        current,
        divergence: statsFromPatch(await this.createPatch(this.index.latest, current), divergenceFiles),
        scope: { id: `restore:${target.id}:${target.action}`, label: target.label, before: current, after: target.snapshot, stats: statsFromPatch(await this.createPatch(current, target.snapshot), files) },
      };
    });
  }

  async previewRollback(idOrName: string): Promise<RollbackPreview> {
    const checkpoint = this.checkpoint(idOrName);
    if (!checkpoint) throw new Error(`Checkpoint not found: ${idOrName}`);
    const preview = await this.previewRestore({ id: checkpoint.id, label: `Restore checkpoint ${checkpoint.name ?? checkpoint.id}`, action: "checkpoint", snapshot: checkpoint.snapshot });
    preview.checkpoint = checkpoint;
    return preview;
  }

  async rollback(preview: RollbackPreview, confirmation: RollbackConfirmation, turnIndex: number, timestamp = Date.now()): Promise<RollbackResult> {
    if (confirmation?.confirmed !== true) throw new Error("Restore requires explicit confirmation");
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const before = await this.captureSnapshot();
      if (changedPaths(before, preview.current).length > 0) throw new Error("Files changed after the restore preview; generate a new preview");
      if (changedPaths(before, preview.target.snapshot).length === 0) throw new Error("Restore target is already the current state");

      const safetyCheckpoint = this.addCheckpoint("automatic", before, undefined, `Before restoring ${preview.target.label}`, preview.target.id);
      await this.saveIndex();
      try {
        await this.restoreSnapshot(before, preview.target.snapshot);
      } catch (error) {
        // A safety checkpoint is already durable. Also make a best-effort automatic
        // recovery so an I/O failure does not leave a silently half-restored tree.
        try {
          const partial = await this.captureSnapshot();
          await this.restoreSnapshot(partial, before);
          const recovered = await this.captureSnapshot();
          if (changedPaths(recovered, before).length > 0) throw new Error("recovery verification failed");
        } catch (recoveryError) {
          throw new Error(`Restore failed and automatic recovery also failed; use safety checkpoint ${safetyCheckpoint.id}: ${String(error)}; recovery: ${String(recoveryError)}`);
        }
        throw new Error(`Restore failed; original state was recovered and safety checkpoint ${safetyCheckpoint.id} was retained: ${String(error)}`);
      }
      const after = await this.captureSnapshot();
      if (changedPaths(after, preview.target.snapshot).length > 0) throw new Error("Restore verification failed");
      const turn: TurnRecord = {
        id: `restore-${turnIndex}-${timestamp}`,
        turnIndex,
        startedAt: new Date(timestamp).toISOString(),
        endedAt: new Date().toISOString(),
        before,
        after,
        stats: statsFromPatch(await this.createPatch(before, after), changedPaths(before, after).length),
        kind: "restoration",
        restoration: { target: preview.target.label, action: preview.target.action, divergenceFiles: preview.divergence.files },
      };
      this.index.latest = after;
      this.index.reviewTurns.push(turn);
      this.index.recoveryTurns.push(turn);
      this.trimTurns(this.index.reviewTurns);
      this.trimTurns(this.index.recoveryTurns);
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return { safetyCheckpoint, turn };
    });
  }

  listCheckpoints(): Checkpoint[] {
    return [...(this.index?.checkpoints ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async promoteCheckpoint(id: string, name: string): Promise<Checkpoint> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("Named checkpoints require a non-empty name");
      if (this.index.checkpoints.some((item) => item.kind === "named" && item.name === normalizedName)) throw new Error(`Checkpoint already exists: ${normalizedName}`);
      const checkpoint = this.index.checkpoints.find((item) => item.id === id);
      if (!checkpoint) throw new Error(`Checkpoint not found: ${id}`);
      if (checkpoint.kind !== "automatic") throw new Error(`Checkpoint is already named: ${checkpoint.name ?? checkpoint.id}`);
      // Mutate the existing record in place: its id, snapshot reference and restore
      // provenance stay identical. Changing kind removes it from rolling retention and
      // makes the existing manifest/blob graph a pinned named-checkpoint GC root.
      checkpoint.kind = "named";
      checkpoint.name = normalizedName;
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return checkpoint;
    });
  }

  async deleteCheckpoint(idOrName: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const index = this.index.checkpoints.findIndex((item) => item.id === idOrName || (item.kind === "named" && item.name === idOrName));
      if (index < 0) return false;
      this.index.checkpoints.splice(index, 1);
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return true;
    });
  }

  async checkpointStorageReport(): Promise<CheckpointStorageReport> {
    const checkpoints = this.index?.checkpoints ?? [];
    const named = checkpoints.filter((item) => item.kind === "named");
    const paths = new Set<string>();
    for (const checkpoint of named) {
      if (checkpoint.snapshot.id) paths.add(join(this.snapshotDir, `${checkpoint.snapshot.id}.json.gz`));
      for (const file of Object.values(checkpoint.snapshot.files)) paths.add(join(this.blobDir, `${file.hash}.gz`));
    }
    let namedBytes = 0;
    for (const path of paths) namedBytes += (await stat(path).catch(() => undefined))?.size ?? 0;
    return {
      checkpoints: checkpoints.length,
      named: named.length,
      automatic: checkpoints.length - named.length,
      namedBytes,
      warningBytes: NAMED_CHECKPOINT_WARNING_BYTES,
      warning: namedBytes >= NAMED_CHECKPOINT_WARNING_BYTES,
    };
  }

  async finishTurn(
    draft: { id: string; turnIndex: number; startedAt: string; before: Snapshot; source?: TurnSource },
    timestamp = Date.now(),
  ): Promise<TurnRecord> {
    return this.exclusive(async () => {
      if (!this.index) throw new Error("Ledger has not been initialized");
      const after = await this.captureSnapshot();
      const changed = changedPaths(draft.before, after);
      const stats = statsFromPatch(await this.createPatch(draft.before, after), changed.length);
      const record: TurnRecord = {
        ...draft,
        endedAt: new Date(timestamp).toISOString(),
        after,
        stats,
      };
      this.index.latest = after;
      this.index.reviewTurns.push(record);
      this.index.recoveryTurns.push(record);
      this.trimTurns(this.index.reviewTurns);
      this.trimTurns(this.index.recoveryTurns);
      this.index.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.garbageCollectBlobs();
      return record;
    });
  }

  sessionStats(after?: Snapshot): DiffStats {
    if (!this.index) return emptyStats();
    return diffStats(this.index.baseline, after ?? this.index.latest);
  }

  currentScope(draft?: { id: string; before: Snapshot }, live?: Snapshot): Scope | undefined {
    if (!this.index) return undefined;
    if (draft) {
      const after = live ?? this.index.latest;
      return { id: "current", label: "Current turn", before: draft.before, after, stats: diffStats(draft.before, after) };
    }
    const latest = this.index.reviewTurns.at(-1);
    if (!latest) return undefined;
    return { id: "current", label: `Current turn · #${latest.turnIndex + 1}`, before: latest.before, after: latest.after, stats: latest.stats };
  }

  scopes(draft?: { id: string; before: Snapshot }, live?: Snapshot): Scope[] {
    if (!this.index) return [];
    const current = this.currentScope(draft, live);
    const currentRecordId = draft ? undefined : this.index.reviewTurns.at(-1)?.id;
    const previous = [...this.index.reviewTurns]
      .reverse()
      .filter((turn) => turn.id !== currentRecordId)
      .map((turn) => ({
        id: `turn:${turn.id}`,
        label: `Turn #${turn.turnIndex + 1} · ${new Date(turn.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        before: turn.before,
        after: turn.after,
        stats: turn.stats,
      }));
    const sessionAfter = live ?? this.index.latest;
    const session: Scope = {
      id: "session",
      label: "Entire session",
      before: this.index.baseline,
      after: sessionAfter,
      stats: diffStats(this.index.baseline, sessionAfter),
    };
    return [...(current ? [current] : []), ...previous, session];
  }

  async calculateStats(before: Snapshot, after: Snapshot): Promise<DiffStats> {
    return this.exclusive(async () => {
      const files = changedPaths(before, after).length;
      return statsFromPatch(await this.createPatch(before, after), files);
    });
  }

  async writePatch(scope: Scope): Promise<string> {
    return this.exclusive(async () => {
      const patch = await this.createPatch(scope.before, scope.after);
      // Keep the watched inode stable: Hunk 0.17.x observes the patch file itself
      // and does not reliably follow atomic rename-over updates.
      await writeFile(this.patchPath, patch || emptyPatch(scope.label));
      return this.patchPath;
    });
  }

  private async gitPaths(): Promise<string[]> {
    const result = await this.pi.exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: this.root,
      timeout: 2_000,
    });
    if (result.code !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
    return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
  }

  private trimTurns(turns: TurnRecord[]): void {
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  }

  private addCheckpoint(kind: CheckpointKind, snapshot: Snapshot, name?: string, sourceLabel?: string, sourceId?: string): Checkpoint {
    if (!this.index) throw new Error("Ledger has not been initialized");
    const normalizedName = name?.trim();
    if (kind === "named") {
      if (!normalizedName) throw new Error("Named checkpoints require a non-empty name");
      if (this.index.checkpoints.some((item) => item.kind === "named" && item.name === normalizedName)) throw new Error(`Checkpoint already exists: ${normalizedName}`);
    } else if (normalizedName) throw new Error("Automatic checkpoints cannot have names");
    const checkpoint: Checkpoint = {
      id: `${kind}-${Date.now()}-${this.index.checkpoints.length}-${snapshot.id!.slice(0, 12)}`,
      kind,
      ...(normalizedName ? { name: normalizedName } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      ...(sourceId ? { sourceId } : {}),
      createdAt: new Date().toISOString(),
      snapshot,
    };
    this.index.checkpoints.push(checkpoint);
    if (kind === "automatic") {
      const automatic = this.index.checkpoints.filter((item) => item.kind === "automatic");
      const remove = new Set(automatic.slice(0, Math.max(0, automatic.length - MAX_AUTOMATIC_CHECKPOINTS)).map((item) => item.id));
      this.index.checkpoints = this.index.checkpoints.filter((item) => !remove.has(item.id));
    }
    this.index.updatedAt = new Date().toISOString();
    return checkpoint;
  }

  private async storeSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    for (const path of Object.keys(snapshot.files)) validateRelativePath(path);
    // Hash the exact uncompressed manifest bytes. File paths are captured in sorted
    // order, so equivalent captures have a stable representation.
    const manifest = JSON.stringify({ createdAt: snapshot.createdAt, files: snapshot.files });
    const id = sha256(manifest);
    const path = join(this.snapshotDir, `${id}.json.gz`);
    if (!(await pathExists(path))) await atomicWrite(path, await gzipAsync(manifest, { level: 6 }));
    return { ...snapshot, id };
  }

  private async readSnapshot(id: string): Promise<Snapshot> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Invalid snapshot id: ${id}`);
    const bytes = await gunzipAsync(await readFile(join(this.snapshotDir, `${id}.json.gz`)));
    if (sha256(bytes) !== id) throw new Error(`Snapshot manifest failed integrity check: ${id}`);
    const parsed = JSON.parse(bytes.toString("utf8")) as Snapshot;
    for (const path of Object.keys(parsed.files ?? {})) validateRelativePath(path);
    return { ...parsed, id };
  }

  private async storeBlob(hash: string, content: Buffer): Promise<void> {
    const path = join(this.blobDir, `${hash}.gz`);
    if (await pathExists(path)) return;
    await atomicWrite(path, await gzipAsync(content, { level: 6 }));
  }

  private async readBlob(hash: string, kind?: FileState["kind"]): Promise<Buffer> {
    const content = await gunzipAsync(await readFile(join(this.blobDir, `${hash}.gz`)));
    if (kind && sha256(Buffer.concat([Buffer.from(`${kind}\0`), content])) !== hash) throw new Error(`Blob failed integrity check: ${hash}`);
    return content;
  }

  private async restoreSnapshot(current: Snapshot, target: Snapshot): Promise<void> {
    // Read and verify every required blob first, so corrupt storage cannot cause a partial restore.
    const contents = new Map<string, Buffer>();
    for (const [path, file] of Object.entries(target.files)) {
      validateRelativePath(path);
      contents.set(file.hash, await this.readBlob(file.hash, file.kind));
    }
    for (const path of Object.keys(current.files)) validateRelativePath(path);

    const changed = changedPaths(current, target);
    const removals = changed.filter((path) => !target.files[path]).sort((a, b) => b.split("/").length - a.split("/").length);
    for (const relativePath of removals) await this.removeLeaf(join(this.root, relativePath));

    const writes = changed.filter((path) => Boolean(target.files[path])).sort((a, b) => a.split("/").length - b.split("/").length);
    for (const relativePath of writes) {
      const destination = join(this.root, relativePath);
      const file = target.files[relativePath]!;
      await this.ensureSafeParent(dirname(destination));
      const temporary = join(dirname(destination), `.pi-rollback-${process.pid}-${Date.now()}-${sha256(relativePath).slice(0, 8)}`);
      await rm(temporary, { force: true });
      if (file.kind === "symlink") await symlink(contents.get(file.hash)!.toString("utf8"), temporary);
      else {
        await writeFile(temporary, contents.get(file.hash)!);
        await chmod(temporary, file.mode);
      }
      await this.removeLeaf(destination);
      await rename(temporary, destination);
    }
  }

  private async removeLeaf(path: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      // Never recursively delete a directory: it may contain ignored or otherwise
      // excluded user data. Empty structural directories are safe to remove.
      await rmdir(path);
    } else {
      await rm(path, { force: true });
    }
  }

  private async ensureSafeParent(path: string): Promise<void> {
    const relative = normalizePath(path.slice(this.root.length)).replace(/^\/+/, "");
    let cursor = this.root;
    for (const part of relative.split("/").filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor).catch(() => undefined);
      if (!info) await mkdir(cursor);
      else if (!info.isDirectory()) throw new Error(`Restore parent is not a directory: ${cursor}`);
    }
  }

  private async materialize(snapshot: Snapshot, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const [relativePath, file] of Object.entries(snapshot.files)) {
      const target = join(destination, relativePath);
      await mkdir(dirname(target), { recursive: true });
      const content = await this.readBlob(file.hash);
      if (file.kind === "symlink") await symlink(content.toString("utf8"), target);
      else {
        await writeFile(target, content);
        await chmod(target, file.mode);
      }
    }
  }

  private async createPatch(before: Snapshot, after: Snapshot): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), "pi-changes-ledger-"));
    try {
      await Promise.all([
        this.materialize(before, join(temporary, "before")),
        this.materialize(after, join(temporary, "after")),
      ]);
      const result = await this.pi.exec(
        "git",
        ["diff", "--no-index", "--binary", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--", "before", "after"],
        { cwd: temporary, timeout: 60_000 },
      );
      if (result.code !== 0 && result.code !== 1) throw new Error(`git diff --no-index failed: ${result.stderr.trim()}`);
      return normalizeMaterializedPatch(result.stdout);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async loadIndex(): Promise<LedgerIndex | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as any;
      if (parsed.version === 1) {
        // Version 1 embedded manifests. Opening the session is the migration
        // boundary: persist each manifest, then let the next save replace index.json.
        const migrate = (snapshot: Snapshot) => this.storeSnapshot(snapshot);
        return {
          ...parsed,
          version: INDEX_VERSION,
          turns: undefined,
          baseline: await migrate(parsed.baseline),
          latest: await migrate(parsed.latest),
          reviewTurns: await Promise.all(parsed.turns.map(async (turn: any) => ({
            ...turn,
            before: await migrate(turn.before),
            after: await migrate(turn.after),
          }))),
          recoveryTurns: await Promise.all(parsed.turns.map(async (turn: any) => ({
            ...turn,
            before: await migrate(turn.before),
            after: await migrate(turn.after),
          }))),
          checkpoints: [],
        } as LedgerIndex;
      }
      if (parsed.version !== 2 && parsed.version !== INDEX_VERSION) return undefined;
      const loadTurns = (turns: any[]) => Promise.all((turns ?? []).map(async (turn: any) => ({
        ...turn,
        before: await this.readSnapshot(turn.before),
        after: await this.readSnapshot(turn.after),
      })));
      const legacyTurns = parsed.turns ?? [];
      return {
        ...parsed,
        version: INDEX_VERSION,
        turns: undefined,
        baseline: await this.readSnapshot(parsed.baseline),
        latest: await this.readSnapshot(parsed.latest),
        reviewTurns: await loadTurns(parsed.reviewTurns ?? legacyTurns),
        recoveryTurns: await loadTurns(parsed.recoveryTurns ?? legacyTurns),
        checkpoints: await Promise.all((parsed.checkpoints ?? []).map(async (checkpoint: any) => ({
          ...checkpoint,
          snapshot: await this.readSnapshot(checkpoint.snapshot),
        }))),
      } as LedgerIndex;
    } catch {
      return undefined;
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    const reference = (snapshot: Snapshot): string => {
      if (!snapshot.id) throw new Error("Snapshot was not persisted");
      return snapshot.id;
    };
    const serialized = {
      ...this.index,
      baseline: reference(this.index.baseline),
      latest: reference(this.index.latest),
      reviewTurns: this.index.reviewTurns.map((turn) => ({
        ...turn,
        before: reference(turn.before),
        after: reference(turn.after),
      })),
      recoveryTurns: this.index.recoveryTurns.map((turn) => ({
        ...turn,
        before: reference(turn.before),
        after: reference(turn.after),
      })),
      checkpoints: this.index.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        snapshot: reference(checkpoint.snapshot),
      })),
    };
    await atomicWrite(this.indexPath, `${JSON.stringify(serialized)}\n`);
    await utimes(this.sessionDir, new Date(), new Date()).catch(() => undefined);
  }

  private async garbageCollectBlobs(): Promise<void> {
    if (!this.index) return;
    const usedBlobs = new Set<string>();
    const usedSnapshots = new Set<string>();
    const include = (snapshot: Snapshot) => {
      if (snapshot.id) usedSnapshots.add(snapshot.id);
      Object.values(snapshot.files).forEach((file) => usedBlobs.add(file.hash));
    };
    include(this.index.baseline);
    include(this.index.latest);
    for (const turn of [...this.index.reviewTurns, ...this.index.recoveryTurns]) {
      include(turn.before);
      include(turn.after);
    }
    for (const checkpoint of this.index.checkpoints) include(checkpoint.snapshot);
    for (const entry of await readdir(this.blobDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith(".gz") && !usedBlobs.has(entry.name.slice(0, -3))) {
        await rm(join(this.blobDir, entry.name), { force: true });
      }
    }
    for (const entry of await readdir(this.snapshotDir, { withFileTypes: true }).catch(() => [])) {
      const id = entry.name.endsWith(".json.gz") ? entry.name.slice(0, -8) : "";
      if (entry.isFile() && id && !usedSnapshots.has(id)) await rm(join(this.snapshotDir, entry.name), { force: true });
    }
  }

  private async pruneGlobalCache(): Promise<void> {
    const now = Date.now();
    const directories = (await readdir(this.cacheRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && entry.name !== this.sessionKey)
      .map((entry) => join(this.cacheRoot, entry.name));
    const metadata = await Promise.all(
      directories.map(async (path) => ({
        path,
        modified: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0,
        size: await directorySize(path),
        pinned: await indexHasNamedCheckpoints(join(path, "index.json")),
      })),
    );
    metadata.sort((a, b) => b.modified - a.modified);
    let total = metadata.reduce((sum, item) => sum + item.size, await directorySize(this.sessionDir));
    for (let index = 0; index < metadata.length; index += 1) {
      const item = metadata[index];
      if (!item) continue;
      if (!item.pinned && (now - item.modified > RETENTION_MS || index >= MAX_CACHE_SESSIONS - 1 || total > MAX_CACHE_BYTES)) {
        await rm(item.path, { recursive: true, force: true });
        total -= item.size;
      }
    }
  }
}

export function emptyStats(): DiffStats {
  return { files: 0, additions: 0, deletions: 0, binary: 0 };
}

export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter((path) => {
    const left = before.files[path];
    const right = after.files[path];
    return !left || !right || left.hash !== right.hash || left.mode !== right.mode || left.kind !== right.kind;
  }).sort();
}

export function diffStats(before: Snapshot, after: Snapshot): DiffStats {
  const stats = emptyStats();
  const paths = changedPaths(before, after);
  stats.files = paths.length;
  for (const path of paths) {
    const left = before.files[path];
    const right = after.files[path];
    if ((left && left.kind !== "file") || (right && right.kind !== "file")) stats.binary += 1;
  }
  return stats;
}

export function statsFromPatch(patch: string, files: number): DiffStats {
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  let inHunk = false;
  let currentFileIsBinary = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      currentFileIsBinary = false;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      if (!currentFileIsBinary) binary += 1;
      currentFileIsBinary = true;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) additions += 1;
    else if (inHunk && line.startsWith("-")) deletions += 1;
  }
  return { files, additions, deletions, binary };
}

export function normalizeMaterializedPatch(patch: string): string {
  return patch
    .replaceAll("a/before/", "a/")
    .replaceAll("a/after/", "a/")
    .replaceAll("b/before/", "b/")
    .replaceAll("b/after/", "b/");
}

export function formatStats(stats: DiffStats): string {
  const binary = stats.binary > 0 ? ` · ${stats.binary} binary` : "";
  return `${stats.files}f · +${stats.additions} −${stats.deletions}${binary}`;
}

function emptyPatch(label: string): string {
  return `# ${label}: no changed files\n`;
}

