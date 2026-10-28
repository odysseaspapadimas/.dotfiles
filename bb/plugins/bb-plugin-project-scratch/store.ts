import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Note, Preview } from "./contract.ts";

const exec = promisify(execFile);
const MAX_NOTE = 512 * 1024;
const MAX_JOURNAL = 4 * 1024 * 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Pending = { root: string; append: string; revision: string; expires: number; done: boolean };

async function exists(path: string) {
  try { return await lstat(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function readRegular(path: string, limit: number): Promise<string | null> {
  if (!(await exists(path))) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Not a regular file or too large: ${path}`);
    const bytes = await file.readFile();
    if (bytes.length > limit) throw new Error(`File is too large: ${path}`);
    return bytes.toString("utf8");
  } finally { await file.close(); }
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe storage directory: ${path}`);
  await chmod(path, 0o700);
}
async function atomicWrite(path: string, text: string, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}

export class ScratchStore {
  private queues = new Map<string, Promise<unknown>>();
  private pending = new Map<string, Pending>();
  private dataDir: string;
  private home: string;
  private stateHome: string | undefined;
  constructor(dataDir: string, home = homedir(), stateHome = process.env.XDG_STATE_HOME) {
    this.dataDir = dataDir; this.home = home; this.stateHome = stateHome;
  }
  private async root(cwd: string) {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute.");
    const directory = await realpath(cwd);
    if (!(await lstat(directory)).isDirectory()) throw new Error("Workspace is not a directory.");
    try {
      const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: directory, timeout: 2000, maxBuffer: 32768 });
      return await realpath(stdout.trim());
    } catch { return directory; }
  }
  private async serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(root) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.queues.set(root, result);
    try { return await result; }
    finally { if (this.queues.get(root) === result) this.queues.delete(root); }
  }
  private async read(root: string): Promise<Note> {
    const key = digest(root);
    const base = join(this.dataDir, "scratch");
    await privateDirectory(base);
    const directory = join(base, key);
    await privateDirectory(directory);
    const path = join(directory, "scratch.md");
    let text = await readRegular(path, MAX_NOTE);
    let imported = false;
    if (text === null) {
      const state = this.stateHome && isAbsolute(this.stateHome) ? this.stateHome : join(this.home, ".local/state");
      text = await readRegular(join(state, "herdr/project-scratch", key, "scratch.md"), MAX_NOTE)
        ?? await readRegular(join(this.home, ".pi/agent/project-state", key, "scratch.md"), MAX_NOTE);
      imported = text !== null;
      text ??= "";
      await atomicWrite(path, text, 0o600);
    }
    return { root, text, revision: digest(text), imported };
  }
  async load(cwd: string) {
    const root = await this.root(cwd);
    return this.serial(root, () => this.read(root));
  }
  async save(cwd: string, text: string, expectedRevision: string, expectedRoot?: string) {
    if (Buffer.byteLength(text) > MAX_NOTE) throw new Error("Scratchpad exceeds 512 KiB.");
    const root = await this.root(cwd);
    if (expectedRoot !== undefined && root !== expectedRoot) throw new Error("Workspace changed. Download your draft, then reopen the scratchpad.");
    return this.serial(root, async () => {
      const current = await this.read(root);
      if (current.revision !== expectedRevision) throw new Error("Another window changed this scratchpad. Download your draft, then reload the saved notes.");
      await atomicWrite(join(this.dataDir, "scratch", digest(root), "scratch.md"), text, 0o600);
      return { ...current, text, revision: digest(text), imported: false };
    });
  }
  private async journal(root: string) {
    const directory = join(root, ".agents");
    const stat = await exists(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(".agents must be a real directory.");
    const path = join(directory, "project-journal.md");
    const text = await readRegular(path, MAX_JOURNAL);
    return { directory, path, text, revision: digest(text === null ? "missing" : `exists:${text}`) };
  }
  async preview(cwd: string, text: string): Promise<Preview> {
    if (!text.trim() || Buffer.byteLength(text) > MAX_NOTE) throw new Error("Select some text or write a note first (up to 512 KiB).");
    const root = await this.root(cwd);
    return this.serial(root, async () => {
      const journal = await this.journal(root);
      const append = `${journal.text && !journal.text.endsWith("\n") ? "\n" : ""}\n## ${new Date().toISOString()}\n\n${text.trim()}\n`;
      if (Buffer.byteLength((journal.text ?? "") + append) > MAX_JOURNAL) throw new Error("The journal would exceed 4 MiB.");
      for (const [key, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(key);
      if (this.pending.size >= 100) throw new Error("Too many open previews. Try again later.");
      const token = randomUUID();
      this.pending.set(token, { root, append, revision: journal.revision, expires: Date.now() + 600_000, done: false });
      return { token, path: journal.path, append };
    });
  }
  async promote(cwd: string, token: string) {
    const root = await this.root(cwd);
    return this.serial(root, async () => {
      const item = this.pending.get(token);
      if (!item || item.root !== root || item.expires < Date.now()) throw new Error("Preview expired. Preview the promotion again.");
      const journal = await this.journal(root);
      if (item.done) return { path: journal.path };
      if (journal.revision !== item.revision) throw new Error("The journal changed after preview. Preview the promotion again.");
      await mkdir(journal.directory, { recursive: true });
      await this.journal(root);
      const lockPath = join(journal.directory, ".project-journal.bb-lock");
      const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Journal is locked by another promotion. Try again after it completes."); });
      try {
        const fresh = await this.journal(root);
        if (fresh.revision !== item.revision) throw new Error("The journal changed after preview. Preview again.");
        const stat = await exists(journal.path);
        await atomicWrite(journal.path, (fresh.text ?? "") + item.append, stat ? stat.mode & 0o777 : 0o644);
        item.done = true;
      } finally { await lock.close(); await rm(lockPath, { force: true }); }
      return { path: journal.path };
    });
  }
}
