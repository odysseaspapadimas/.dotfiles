import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
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
import { basename, dirname, join, resolve, sep } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const INDEX_VERSION = 4;
const MAX_TURNS = 100;
const MAX_FILES = 5_000;
const MAX_REPOSITORIES = 32;
const MAX_WORKSPACE_CHILDREN = 1_000;
const GIT_TIMEOUT_MS = 2_000;
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

export interface RepositoryDescriptor {
  /** Stable display/namespace name. Single-repository ledgers keep paths unprefixed. */
  name: string;
  root: string;
  prefix: string;
}

export interface WorkspaceDiffStats {
  total: DiffStats;
  repositories: Record<string, DiffStats>;
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
  /** Repository-level breakdown; absent only on indexes migrated from older versions. */
  repositoryStats?: Record<string, DiffStats>;
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
  version: 4;
  sessionId: string;
  /** Git root for single-repo mode; Pi cwd workspace root for multi-repo mode. */
  root: string;
  git: boolean;
  workspaceKind: "single" | "multi";
  repositories: RepositoryDescriptor[];
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
  repositoryStats?: Record<string, DiffStats>;
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
  divergenceRepositoryStats?: Record<string, DiffStats>;
}

export interface RollbackConfirmation {
  confirmed: true;
}

export interface RollbackResult {
  safetyCheckpoint: Checkpoint;
  turn: TurnRecord;
}

interface ResolvedLedgerPath {
  repository: RepositoryDescriptor;
  relativePath: string;
  absolutePath: string;
}

interface PreparedRestore {
  contents: Map<string, Buffer>;
  paths: Map<string, ResolvedLedgerPath>;
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

async function lstatOptional(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function validateRepositoryName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /[\0-\x1f\x7f]/u.test(name)) {
    throw new Error(`Unsafe workspace repository name: ${JSON.stringify(name)}`);
  }
  return name;
}

function sameRepositories(left: readonly RepositoryDescriptor[], right: readonly RepositoryDescriptor[]): boolean {
  return left.length === right.length && left.every((repository, index) => {
    const other = right[index];
    return Boolean(other && repository.name === other.name && repository.root === other.root && repository.prefix === other.prefix);
  });
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
  workspaceKind: "single" | "multi" = "single";
  repositories: RepositoryDescriptor[] = [];
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
    const workspace = await this.discoverWorkspace(requestedRoot);
    this.root = workspace.root;
    this.workspaceKind = workspace.kind;
    this.repositories = workspace.repositories;
    this.isGit = true;
    await Promise.all([mkdir(this.blobDir, { recursive: true }), mkdir(this.snapshotDir, { recursive: true })]);

    const restored = await this.loadIndex();
    if (restored) {
      if (restored.root !== this.root || restored.sessionId !== this.sessionId) {
        throw new Error("Changed-files ledger cache does not match the current session workspace");
      }
      if (!sameRepositories(restored.repositories, this.repositories) || restored.workspaceKind !== this.workspaceKind) {
        throw new Error("Changed-files ledger disabled: workspace repository membership changed; restore the original immediate-child repositories or start a new Pi session.");
      }
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
        workspaceKind: this.workspaceKind,
        repositories: this.repositories,
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

  private async discoverWorkspace(requestedRoot: string): Promise<{ root: string; kind: "single" | "multi"; repositories: RepositoryDescriptor[] }> {
    const root = resolve(requestedRoot);
    const direct = await this.pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: GIT_TIMEOUT_MS });
    if (direct.killed) throw new Error(`Changed-files ledger disabled: Git validation timed out for ${root}.`);
    if (direct.code === 0 && direct.stdout.trim()) {
      const gitRoot = resolve(direct.stdout.trim());
      return {
        root: gitRoot,
        kind: "single",
        repositories: [{ name: validateRepositoryName(basename(gitRoot)), root: gitRoot, prefix: "" }],
      };
    }

    const rootMarker = await lstatOptional(join(root, ".git"));
    if (rootMarker) {
      throw new Error(`Changed-files ledger disabled: ${root} has a .git marker but failed bounded Git worktree validation: ${direct.stderr.trim()}`);
    }
    if (root === resolve(homedir())) {
      throw new Error("Changed-files ledger disabled: $HOME is not inside a Git worktree and cannot be used as a multi-repository workspace.");
    }

    const candidates: Array<{ name: string; root: string }> = [];
    let children = 0;
    const directory = await opendir(root);
    for await (const entry of directory) {
      children += 1;
      if (children > MAX_WORKSPACE_CHILDREN) {
        throw new Error(`Changed-files ledger disabled: workspace has more than ${MAX_WORKSPACE_CHILDREN} immediate children.`);
      }
      const childRoot = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        if (await lstatOptional(join(childRoot, ".git"))) {
          throw new Error(`Changed-files ledger disabled: symlinked repository candidate is not allowed: ${entry.name}`);
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const marker = await lstatOptional(join(childRoot, ".git"));
      if (!marker) continue;
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
        throw new Error(`Changed-files ledger disabled: unsafe .git marker in immediate child ${entry.name}.`);
      }
      candidates.push({ name: validateRepositoryName(entry.name), root: childRoot });
      if (candidates.length > MAX_REPOSITORIES) {
        throw new Error(`Changed-files ledger disabled: workspace has more than ${MAX_REPOSITORIES} immediate-child repositories.`);
      }
    }

    const repositories = await Promise.all(candidates.map(async (candidate): Promise<RepositoryDescriptor> => {
      const [top, superproject] = await Promise.all([
        this.pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: candidate.root, timeout: GIT_TIMEOUT_MS }),
        this.pi.exec("git", ["rev-parse", "--show-superproject-working-tree"], { cwd: candidate.root, timeout: GIT_TIMEOUT_MS }),
      ]);
      if (top.killed || superproject.killed) throw new Error(`Changed-files ledger disabled: Git validation timed out for repository ${candidate.name}.`);
      if (top.code !== 0 || !top.stdout.trim()) {
        throw new Error(`Changed-files ledger disabled: immediate child ${candidate.name} has a .git marker but is not a valid Git worktree: ${top.stderr.trim()}`);
      }
      if (resolve(top.stdout.trim()) !== resolve(candidate.root)) {
        throw new Error(`Changed-files ledger disabled: repository ${candidate.name} resolves outside its immediate child directory.`);
      }
      if (superproject.code !== 0) {
        throw new Error(`Changed-files ledger disabled: could not validate superproject state for ${candidate.name}: ${superproject.stderr.trim()}`);
      }
      if (superproject.stdout.trim()) {
        throw new Error(`Changed-files ledger disabled: submodule repository candidates are not allowed: ${candidate.name}`);
      }
      return { name: candidate.name, root: resolve(candidate.root), prefix: candidate.name };
    }));
    repositories.sort((left, right) => left.name.localeCompare(right.name));
    if (repositories.length === 0) {
      throw new Error(`Changed-files ledger disabled: ${root} is not inside a Git worktree and has no independent immediate-child Git repositories.`);
    }
    return { root, kind: "multi", repositories };
  }

  private async validateWorkspaceMembership(): Promise<void> {
    const current = await this.discoverWorkspace(this.root);
    if (current.root !== this.root || current.kind !== this.workspaceKind || !sameRepositories(current.repositories, this.repositories)) {
      throw new Error("Changed-files ledger disabled: workspace repository membership changed; no repository was skipped.");
    }
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
    if (!this.isGit) throw new Error("Changed-files ledger is not initialized in a Git workspace");
    await this.validateWorkspaceMembership();
    const paths = await this.gitPaths();
    if (paths.length > MAX_FILES) {
      throw new Error(`Changed-files ledger disabled: workspace has ${paths.length} candidate files (limit ${MAX_FILES}).`);
    }

    // Preflight metadata across every repository before reading any content. Content is
    // then fully read and rechecked before any blob is stored, so a racing oversized file
    // cannot leave a partial workspace snapshot in the cache.
    const candidates: Array<{
      ledgerPath: string;
      absolutePath: string;
      info: Stats;
      kind: "file" | "symlink";
    }> = [];
    let totalBytes = 0;
    for (const listed of paths) {
      const absolutePath = join(listed.repository.root, listed.relativePath);
      await this.validateSafeParent(dirname(absolutePath), listed.repository.root);
      const info = await lstatOptional(absolutePath);
      if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
      const kind = info.isSymbolicLink() ? "symlink" : "file";
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `Changed-files ledger disabled: ${listed.ledgerPath} is ${info.size} bytes (per-file limit ${MAX_FILE_BYTES}).`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`Changed-files ledger disabled: workspace candidate files exceed ${MAX_TOTAL_BYTES} total bytes.`);
      }
      candidates.push({ ledgerPath: listed.ledgerPath, absolutePath, info, kind });
    }

    const loaded: Array<(typeof candidates)[number] & { content: Buffer }> = [];
    totalBytes = 0;
    for (const candidate of candidates) {
      const content = candidate.kind === "symlink"
        ? Buffer.from(await readlink(candidate.absolutePath), "utf8")
        : await readFile(candidate.absolutePath);
      if (content.byteLength > MAX_FILE_BYTES) {
        throw new Error(`Changed-files ledger disabled: ${candidate.ledgerPath} grew beyond the per-file limit ${MAX_FILE_BYTES}.`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`Changed-files ledger disabled: workspace candidate content exceeds ${MAX_TOTAL_BYTES} total bytes.`);
      }
      loaded.push({ ...candidate, content });
    }

    const files: Record<string, FileState> = {};
    for (const candidate of loaded) {
      const hash = sha256(Buffer.concat([Buffer.from(`${candidate.kind}\0`), candidate.content]));
      await this.storeBlob(hash, candidate.content);
      files[candidate.ledgerPath] = {
        hash,
        kind: candidate.kind,
        mode: candidate.info.mode & 0o777,
        size: candidate.content.byteLength,
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
      const divergence = await this.computeWorkspaceStats(this.index.latest, current);
      const restoration = await this.computeWorkspaceStats(current, target.snapshot);
      return {
        target,
        current,
        divergence: divergence.total,
        divergenceRepositoryStats: divergence.repositories,
        scope: {
          id: `restore:${target.id}:${target.action}`,
          label: target.label,
          before: current,
          after: target.snapshot,
          stats: restoration.total,
          repositoryStats: restoration.repositories,
        },
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

      // Validate every repository and every target blob before making the composite
      // safety checkpoint durable. No affected repository can be silently omitted.
      const prepared = await this.preflightRestore(before, preview.target.snapshot);
      const safetyCheckpoint = this.addCheckpoint("automatic", before, undefined, `Before restoring ${preview.target.label}`, preview.target.id);
      await this.saveIndex();
      try {
        await this.restoreSnapshot(before, preview.target.snapshot, prepared);
      } catch (error) {
        // A safety checkpoint is already durable. Also make a best-effort automatic
        // recovery so an I/O failure does not leave a silently half-restored workspace.
        try {
          const partial = await this.captureSnapshot();
          const recovery = await this.preflightRestore(partial, before);
          await this.restoreSnapshot(partial, before, recovery);
          const recovered = await this.captureSnapshot();
          if (changedPaths(recovered, before).length > 0) throw new Error("recovery verification failed");
        } catch (recoveryError) {
          throw new Error(`Restore failed and automatic recovery also failed; use safety checkpoint ${safetyCheckpoint.id}: ${String(error)}; recovery: ${String(recoveryError)}`);
        }
        throw new Error(`Restore failed; original state was recovered and safety checkpoint ${safetyCheckpoint.id} was retained: ${String(error)}`);
      }
      const after = await this.captureSnapshot();
      if (changedPaths(after, preview.target.snapshot).length > 0) throw new Error("Restore verification failed");
      const restorationStats = await this.computeWorkspaceStats(before, after);
      const turn: TurnRecord = {
        id: `restore-${turnIndex}-${timestamp}`,
        turnIndex,
        startedAt: new Date(timestamp).toISOString(),
        endedAt: new Date().toISOString(),
        before,
        after,
        stats: restorationStats.total,
        repositoryStats: restorationStats.repositories,
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
      const stats = await this.computeWorkspaceStats(draft.before, after);
      const record: TurnRecord = {
        ...draft,
        endedAt: new Date(timestamp).toISOString(),
        after,
        stats: stats.total,
        repositoryStats: stats.repositories,
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
    return {
      id: "current",
      label: `Current turn · #${latest.turnIndex + 1}`,
      before: latest.before,
      after: latest.after,
      stats: latest.stats,
      ...(latest.repositoryStats ? { repositoryStats: latest.repositoryStats } : {}),
    };
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
        ...(turn.repositoryStats ? { repositoryStats: turn.repositoryStats } : {}),
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

  async calculateWorkspaceStats(before: Snapshot, after: Snapshot): Promise<WorkspaceDiffStats> {
    return this.exclusive(() => this.computeWorkspaceStats(before, after));
  }

  async calculateStats(before: Snapshot, after: Snapshot): Promise<DiffStats> {
    return (await this.calculateWorkspaceStats(before, after)).total;
  }

  private async computeWorkspaceStats(before: Snapshot, after: Snapshot): Promise<WorkspaceDiffStats> {
    const paths = changedPaths(before, after);
    const patch = await this.createPatch(before, after);
    return {
      total: statsFromPatch(patch, paths.length),
      repositories: repositoryStatsFromPatch(patch, paths, this.repositories),
    };
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

  private async gitPaths(): Promise<Array<{ repository: RepositoryDescriptor; relativePath: string; ledgerPath: string }>> {
    const listings = await Promise.all(this.repositories.map(async (repository) => {
      const result = await this.pi.exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
        cwd: repository.root,
        timeout: GIT_TIMEOUT_MS,
      });
      if (result.killed) throw new Error(`git ls-files timed out for repository ${repository.name}`);
      if (result.code !== 0) throw new Error(`git ls-files failed for repository ${repository.name}: ${result.stderr.trim()}`);
      const relativePaths = [...new Set(result.stdout.split("\0").filter(Boolean).map(validateRelativePath))].sort();
      return relativePaths.map((relativePath) => ({
        repository,
        relativePath,
        ledgerPath: validateRelativePath(repository.prefix ? `${repository.prefix}/${relativePath}` : relativePath),
      }));
    }));
    return listings.flat().sort((left, right) => left.ledgerPath.localeCompare(right.ledgerPath));
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

  private resolveLedgerPath(path: string): ResolvedLedgerPath {
    const ledgerPath = validateRelativePath(path);
    let repository: RepositoryDescriptor | undefined;
    let relativePath = ledgerPath;
    if (this.workspaceKind === "multi") {
      const slash = ledgerPath.indexOf("/");
      if (slash <= 0) throw new Error(`Workspace snapshot path is not repository-namespaced: ${ledgerPath}`);
      const prefix = ledgerPath.slice(0, slash);
      repository = this.repositories.find((candidate) => candidate.prefix === prefix);
      relativePath = validateRelativePath(ledgerPath.slice(slash + 1));
    } else {
      repository = this.repositories[0];
    }
    if (!repository) throw new Error(`Workspace snapshot references an unknown repository: ${ledgerPath}`);
    const absolutePath = resolve(repository.root, relativePath);
    if (!absolutePath.startsWith(`${repository.root}${sep}`)) throw new Error(`Workspace snapshot path escapes repository ${repository.name}: ${ledgerPath}`);
    return { repository, relativePath, absolutePath };
  }

  private async preflightRestore(current: Snapshot, target: Snapshot): Promise<PreparedRestore> {
    await this.validateWorkspaceMembership();
    const paths = new Map<string, ResolvedLedgerPath>();
    for (const path of new Set([...Object.keys(current.files), ...Object.keys(target.files)])) {
      const resolvedPath = this.resolveLedgerPath(path);
      paths.set(path, resolvedPath);
      await this.validateSafeParent(dirname(resolvedPath.absolutePath), resolvedPath.repository.root);
    }
    const contents = new Map<string, Buffer>();
    for (const [path, file] of Object.entries(target.files)) {
      contents.set(file.hash, await this.readBlob(file.hash, file.kind));
    }
    return { contents, paths };
  }

  private async restoreSnapshot(current: Snapshot, target: Snapshot, prepared: PreparedRestore): Promise<void> {
    const changed = changedPaths(current, target);
    const removals = changed.filter((path) => !target.files[path]).sort((a, b) => b.split("/").length - a.split("/").length);
    for (const path of removals) await this.removeLeaf(prepared.paths.get(path)!.absolutePath);

    const writes = changed.filter((path) => Boolean(target.files[path])).sort((a, b) => a.split("/").length - b.split("/").length);
    for (const path of writes) {
      const resolvedPath = prepared.paths.get(path)!;
      const destination = resolvedPath.absolutePath;
      const file = target.files[path]!;
      await this.ensureSafeParent(dirname(destination), resolvedPath.repository.root);
      const temporary = join(dirname(destination), `.pi-rollback-${process.pid}-${Date.now()}-${sha256(path).slice(0, 8)}`);
      await rm(temporary, { force: true });
      if (file.kind === "symlink") await symlink(prepared.contents.get(file.hash)!.toString("utf8"), temporary);
      else {
        await writeFile(temporary, prepared.contents.get(file.hash)!);
        await chmod(temporary, file.mode);
      }
      await this.removeLeaf(destination);
      await rename(temporary, destination);
    }
  }

  private async removeLeaf(path: string): Promise<void> {
    const info = await lstatOptional(path);
    if (!info) return;
    if (info.isDirectory()) {
      // Never recursively delete a directory: it may contain ignored or otherwise
      // excluded user data. Empty structural directories are safe to remove.
      await rmdir(path);
    } else {
      await rm(path, { force: true });
    }
  }

  private async validateSafeParent(path: string, repositoryRoot: string): Promise<void> {
    const relative = normalizePath(path.slice(repositoryRoot.length)).replace(/^\/+/, "");
    let cursor = repositoryRoot;
    for (const part of relative.split("/").filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await lstatOptional(cursor);
      if (!info) return;
      if (!info.isDirectory()) throw new Error(`Restore parent is not a directory: ${cursor}`);
    }
  }

  private async ensureSafeParent(path: string, repositoryRoot: string): Promise<void> {
    const relative = normalizePath(path.slice(repositoryRoot.length)).replace(/^\/+/, "");
    let cursor = repositoryRoot;
    for (const part of relative.split("/").filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await lstatOptional(cursor);
      if (!info) await mkdir(cursor);
      else if (!info.isDirectory()) throw new Error(`Restore parent is not a directory: ${cursor}`);
    }
  }

  private async materialize(snapshot: Snapshot, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const [relativePath, file] of Object.entries(snapshot.files)) {
      const target = join(destination, validateRelativePath(relativePath));
      await mkdir(dirname(target), { recursive: true });
      const content = await this.readBlob(file.hash, file.kind);
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
        ["-c", "core.quotePath=false", "diff", "--no-index", "--binary", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--", "before", "after"],
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
          workspaceKind: "single",
          repositories: this.repositories,
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
      if (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== INDEX_VERSION) return undefined;
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
        workspaceKind: parsed.workspaceKind ?? "single",
        repositories: parsed.repositories ?? this.repositories,
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

export function repositoryStatsFromPatch(
  patch: string,
  changed: readonly string[],
  repositories: readonly RepositoryDescriptor[],
): Record<string, DiffStats> {
  const result = Object.fromEntries(repositories.map((repository) => [repository.name, emptyStats()]));
  const repositoryForPath = (path: string): RepositoryDescriptor | undefined => {
    if (repositories.length === 1 && repositories[0]?.prefix === "") return repositories[0];
    return repositories.find((repository) => path.startsWith(`${repository.prefix}/`));
  };
  for (const path of changed) {
    const repository = repositoryForPath(path);
    if (!repository) throw new Error(`Changed path is not namespaced to a workspace repository: ${path}`);
    result[repository.name]!.files += 1;
  }

  let current: DiffStats | undefined;
  let inHunk = false;
  let currentFileIsBinary = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const repository = repositories.length === 1 && repositories[0]?.prefix === ""
        ? repositories[0]
        : repositories.find((candidate) => line.includes(`a/${candidate.prefix}/`) || line.includes(`b/${candidate.prefix}/`));
      if (!repository) throw new Error(`Patch file is not namespaced to a workspace repository: ${line}`);
      current = result[repository.name];
      inHunk = false;
      currentFileIsBinary = false;
    } else if (current && (line.startsWith("Binary files ") || line === "GIT binary patch")) {
      if (!currentFileIsBinary) current.binary += 1;
      currentFileIsBinary = true;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (current && inHunk && line.startsWith("+")) current.additions += 1;
    else if (current && inHunk && line.startsWith("-")) current.deletions += 1;
  }
  return result;
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
  return patch.split("\n").map((line) => {
    if (!line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("Binary files ")) return line;
    return line
      .replaceAll("a/before/", "a/")
      .replaceAll("a/after/", "a/")
      .replaceAll("b/before/", "b/")
      .replaceAll("b/after/", "b/");
  }).join("\n");
}

export function formatRepositoryStats(stats: Record<string, DiffStats>): string {
  return Object.entries(stats)
    .filter(([, value]) => value.files > 0)
    .map(([repository, value]) => `${repository}: ${formatStats(value)}`)
    .join(" · ");
}

export function formatStats(stats: DiffStats): string {
  const binary = stats.binary > 0 ? ` · ${stats.binary} binary` : "";
  return `${stats.files}f · +${stats.additions} −${stats.deletions}${binary}`;
}

function emptyPatch(label: string): string {
  return `# ${label}: no changed files\n`;
}

