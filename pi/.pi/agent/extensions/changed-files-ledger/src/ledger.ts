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
const INDEX_VERSION = 1;
const MAX_TURNS = 100;
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_SESSIONS = 20;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
export interface FileState {
  hash: string;
  kind: "file" | "symlink";
  mode: number;
  size: number;
}

export interface Snapshot {
  createdAt: string;
  files: Record<string, FileState>;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  binary: number;
}

export interface TurnRecord {
  id: string;
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  before: Snapshot;
  after: Snapshot;
  stats: DiffStats;
}

export interface LedgerIndex {
  version: 1;
  sessionId: string;
  root: string;
  git: boolean;
  createdAt: string;
  updatedAt: string;
  baseline: Snapshot;
  latest: Snapshot;
  turns: TurnRecord[];
}

export interface Scope {
  id: string;
  label: string;
  before: Snapshot;
  after: Snapshot;
  stats: DiffStats;
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

export class ChangedFilesLedger {
  readonly cacheRoot: string;
  readonly sessionDir: string;
  readonly blobDir: string;
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
    await mkdir(this.blobDir, { recursive: true });

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
        turns: [],
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
    for (const relativePath of paths) {
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
      files[normalizePath(candidate.relativePath)] = {
        hash,
        kind: candidate.kind,
        mode: candidate.info.mode & 0o777,
        size: content.byteLength,
      };
    }
    return { createdAt: new Date().toISOString(), files };
  }

  async beginTurn(turnIndex: number, timestamp = Date.now()): Promise<{ id: string; turnIndex: number; startedAt: string; before: Snapshot }> {
    return this.exclusive(async () => ({
      id: `${turnIndex}-${timestamp}`,
      turnIndex,
      startedAt: new Date(timestamp).toISOString(),
      before: await this.captureSnapshot(),
    }));
  }

  async refreshLatest(): Promise<Snapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.captureSnapshot();
      if (this.index) this.index.latest = snapshot;
      return snapshot;
    });
  }

  async finishTurn(
    draft: { id: string; turnIndex: number; startedAt: string; before: Snapshot },
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
      this.index.turns.push(record);
      if (this.index.turns.length > MAX_TURNS) this.index.turns.splice(0, this.index.turns.length - MAX_TURNS);
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
    const latest = this.index.turns.at(-1);
    if (!latest) return undefined;
    return { id: "current", label: `Current turn · #${latest.turnIndex + 1}`, before: latest.before, after: latest.after, stats: latest.stats };
  }

  scopes(draft?: { id: string; before: Snapshot }, live?: Snapshot): Scope[] {
    if (!this.index) return [];
    const current = this.currentScope(draft, live);
    const currentRecordId = draft ? undefined : this.index.turns.at(-1)?.id;
    const previous = [...this.index.turns]
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

  private async storeBlob(hash: string, content: Buffer): Promise<void> {
    const path = join(this.blobDir, `${hash}.gz`);
    if (await pathExists(path)) return;
    await atomicWrite(path, await gzipAsync(content, { level: 6 }));
  }

  private async readBlob(hash: string): Promise<Buffer> {
    return gunzipAsync(await readFile(join(this.blobDir, `${hash}.gz`)));
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
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as LedgerIndex;
      return parsed.version === INDEX_VERSION ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index)}\n`);
    await utimes(this.sessionDir, new Date(), new Date()).catch(() => undefined);
  }

  private async garbageCollectBlobs(): Promise<void> {
    if (!this.index) return;
    const used = new Set<string>();
    const include = (snapshot: Snapshot) => Object.values(snapshot.files).forEach((file) => used.add(file.hash));
    include(this.index.baseline);
    include(this.index.latest);
    for (const turn of this.index.turns) {
      include(turn.before);
      include(turn.after);
    }
    for (const entry of await readdir(this.blobDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith(".gz") && !used.has(entry.name.slice(0, -3))) {
        await rm(join(this.blobDir, entry.name), { force: true });
      }
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
      })),
    );
    metadata.sort((a, b) => b.modified - a.modified);
    let total = metadata.reduce((sum, item) => sum + item.size, await directorySize(this.sessionDir));
    for (let index = 0; index < metadata.length; index += 1) {
      const item = metadata[index];
      if (!item) continue;
      if (now - item.modified > RETENTION_MS || index >= MAX_CACHE_SESSIONS - 1 || total > MAX_CACHE_BYTES) {
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

