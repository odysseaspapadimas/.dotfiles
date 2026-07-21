import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChangedFilesLedger, changedPaths, normalizeMaterializedPatch } from "../src/ledger.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakePi(): ExtensionAPI {
  return {
    async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options?.cwd,
          timeout: options?.timeout,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "utf8",
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          code: typeof failure.code === "number" ? failure.code : 1,
          killed: failure.killed ?? false,
        };
      }
    },
  } as ExtensionAPI;
}

function listingPi(root: string, paths: string[]): ExtensionAPI {
  return {
    async exec(_command: string, args: string[]) {
      if (args[0] === "rev-parse") return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
      if (args[0] === "ls-files") return { stdout: `${paths.join("\0")}\0`, stderr: "", code: 0, killed: false };
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  } as ExtensionAPI;
}

async function initRepo(path: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "ledger@example.test"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "Ledger Test"], { cwd: path });
  await writeFile(join(path, "tracked.txt"), "one\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: path });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: path });
}

test("refuses a non-Git home cwd before creating or scanning a cache", async () => {
  const cache = join(await temporaryDirectory("pi-ledger-home-guard-"), "cache-does-not-exist");
  const ledger = new ChangedFilesLedger(fakePi(), "session-home", process.env.HOME!, cache);
  const started = performance.now();
  await assert.rejects(
    ledger.initialize(),
    /\$HOME is not inside a Git worktree\. Start Pi in a bounded project directory\./,
  );
  assert.ok(performance.now() - started < 1_000, "home guard should fail quickly");
  await assert.rejects(access(cache), /ENOENT/);
});

test("refuses any non-Git root rather than recursively traversing it", async () => {
  const root = await temporaryDirectory("pi-ledger-non-git-");
  const cache = join(await temporaryDirectory("pi-ledger-non-git-cache-"), "cache-does-not-exist");
  await writeFile(join(root, "would-have-been-read.txt"), "do not scan\n");
  const ledger = new ChangedFilesLedger(fakePi(), "session-non-git", root, cache);
  await assert.rejects(ledger.initialize(), /is not inside a Git worktree/);
  await assert.rejects(access(cache), /ENOENT/);
});

test("rejects too many Git candidates before stat or content reads", async () => {
  const root = await temporaryDirectory("pi-ledger-many-");
  const cache = join(await temporaryDirectory("pi-ledger-many-cache-"), "cache");
  const paths = Array.from({ length: 5_001 }, (_, index) => `missing-${index}.txt`);
  const ledger = new ChangedFilesLedger(listingPi(root, paths), "session-many", root, cache);
  await assert.rejects(ledger.initialize(), /5001 candidate files \(limit 5000\)/);
  assert.deepEqual(await readdir(ledger.blobDir), []);
});

test("rejects a large file during metadata preflight without storing a blob", async () => {
  const root = await temporaryDirectory("pi-ledger-large-");
  const cache = join(await temporaryDirectory("pi-ledger-large-cache-"), "cache");
  await writeFile(join(root, "large.bin"), "");
  await truncate(join(root, "large.bin"), 20 * 1024 * 1024 + 1);
  const ledger = new ChangedFilesLedger(listingPi(root, ["large.bin"]), "session-large", root, cache);
  await assert.rejects(ledger.initialize(), /per-file limit 20971520/);
  assert.deepEqual(await readdir(ledger.blobDir), []);
});

test("records repeated edits and untracked files as independent historical turns", async () => {
  const repo = await temporaryDirectory("pi-ledger-repo-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-repeat", repo, cache);
  await ledger.initialize();

  const first = await ledger.beginTurn(0, 1_000);
  await writeFile(join(repo, "tracked.txt"), "one\ntwo\n");
  await writeFile(join(repo, "untracked.txt"), "new\n");
  const firstRecord = await ledger.finishTurn(first, 2_000);
  assert.deepEqual(changedPaths(firstRecord.before, firstRecord.after), ["tracked.txt", "untracked.txt"]);
  assert.equal(firstRecord.stats.files, 2);
  assert.equal(firstRecord.stats.additions, 2);

  const second = await ledger.beginTurn(1, 3_000);
  await writeFile(join(repo, "tracked.txt"), "one\nthree\n");
  await writeFile(join(repo, "untracked.txt"), "newer\n");
  const secondRecord = await ledger.finishTurn(second, 4_000);
  assert.deepEqual(changedPaths(secondRecord.before, secondRecord.after), ["tracked.txt", "untracked.txt"]);
  assert.equal(secondRecord.stats.additions, 2);
  assert.equal(secondRecord.stats.deletions, 2);

  const previousScope = ledger.scopes().find((scope) => scope.id === `turn:${firstRecord.id}`);
  assert.ok(previousScope);
  const patchPath = await ledger.writePatch(previousScope);
  const patch = await readFile(patchPath, "utf8");
  assert.match(patch, /diff --git a\/tracked\.txt b\/tracked\.txt/);
  assert.match(patch, /diff --git a\/untracked\.txt b\/untracked\.txt/);
  assert.match(patch, /\+two/);
  assert.doesNotMatch(patch, /\+three/);
});

test("restores persisted snapshots without embedding patches in the index", async () => {
  const repo = await temporaryDirectory("pi-ledger-restore-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const firstLedger = new ChangedFilesLedger(fakePi(), "session-restore", repo, cache);
  await firstLedger.initialize();
  const draft = await firstLedger.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await firstLedger.finishTurn(draft);

  const serialized = await readFile(firstLedger.indexPath, "utf8");
  assert.doesNotMatch(serialized, /diff --git|@@ -/);

  const restored = new ChangedFilesLedger(fakePi(), "session-restore", repo, cache);
  await restored.initialize();
  assert.equal(restored.index?.turns.length, 1);
  assert.equal(restored.sessionStats().files, 1);
  const session = restored.scopes().find((scope) => scope.id === "session");
  assert.ok(session);
  const patch = await readFile(await restored.writePatch(session), "utf8");
  assert.match(patch, /\+changed/);
});

test("normalizes materialized directory prefixes for Hunk sidebar paths", () => {
  const input = [
    "diff --git a/before/src/a.ts b/after/src/a.ts",
    "--- a/before/src/a.ts",
    "+++ b/after/src/a.ts",
    "Binary files a/before/img.png and b/after/img.png differ",
  ].join("\n");
  const normalized = normalizeMaterializedPatch(input);
  assert.match(normalized, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.doesNotMatch(normalized, /before\/|after\//);
});
