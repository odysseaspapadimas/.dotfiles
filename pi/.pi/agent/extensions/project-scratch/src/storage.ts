import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectScratchPaths {
  canonicalRoot: string;
  git: boolean;
  key: string;
  directory: string;
  scratchPath: string;
  metadataPath: string;
}

async function canonical(path: string): Promise<string> {
  return realpath(resolve(path)).catch(() => resolve(path));
}

export async function resolveProjectScratch(cwd: string, stateRoot = join(homedir(), ".pi", "agent", "project-state")): Promise<ProjectScratchPaths> {
  const canonicalCwd = await canonical(cwd);
  let root = canonicalCwd;
  let git = false;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalCwd, timeout: 2_000 });
    if (stdout.trim()) {
      root = await canonical(stdout.trim());
      git = true;
    }
  } catch {}
  const key = createHash("sha256").update(root).digest("hex");
  const directory = join(stateRoot, key);
  return { canonicalRoot: root, git, key, directory, scratchPath: join(directory, "scratch.md"), metadataPath: join(directory, "project.json") };
}

export async function prepareProjectScratch(paths: ProjectScratchPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700).catch(() => undefined);
  await atomicPrivateWrite(paths.metadataPath, `${JSON.stringify({ version: 1, root: paths.canonicalRoot, git: paths.git, key: paths.key }, null, 2)}\n`);
}

export async function readScratch(path: string): Promise<string> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
}

export function promotionAppend(content: string, now = new Date()): string {
  const body = content.trim();
  if (!body) throw new Error("Nothing selected to promote");
  const date = now.toISOString().slice(0, 10);
  return `\n\n## ${date}\n\n${body}\n`;
}

export async function appendJournalAtomically(projectRoot: string, append: string): Promise<string> {
  const path = join(projectRoot, ".agents", "project-journal.md");
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.project-journal-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, current + append, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return path;
}
