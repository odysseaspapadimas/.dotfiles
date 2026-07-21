import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ChangedFilesLedger,
  NAMED_CHECKPOINT_WARNING_BYTES,
  changedPaths,
  normalizeMaterializedPatch,
} from "../src/ledger.js";

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
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
  assert.equal(restored.index?.recoveryTurns.length, 1);
  assert.equal(restored.sessionStats().files, 1);
  const session = restored.scopes().find((scope) => scope.id === "session");
  assert.ok(session);
  const patch = await readFile(await restored.writePatch(session), "utf8");
  assert.match(patch, /\+changed/);
});

test("stores version-3 indexes as snapshot IDs and verifies addressable manifests", async () => {
  const repo = await temporaryDirectory("pi-ledger-manifests-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-manifests", repo, cache);
  await ledger.initialize();
  const draft = await ledger.beginTurn(0, Date.now(), { entryId: "stable-user-entry", excerpt: "Change the tracked file" });
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await ledger.finishTurn(draft);

  const persisted = JSON.parse(await readFile(ledger.indexPath, "utf8"));
  assert.equal(persisted.version, 3);
  assert.match(persisted.baseline, /^[a-f0-9]{64}$/);
  assert.match(persisted.latest, /^[a-f0-9]{64}$/);
  assert.equal(typeof persisted.recoveryTurns[0].before, "string");
  assert.equal(typeof persisted.recoveryTurns[0].after, "string");
  assert.deepEqual(persisted.recoveryTurns[0].source, { entryId: "stable-user-entry", excerpt: "Change the tracked file" });
  assert.equal(JSON.stringify(persisted).includes('"hash"'), false);

  for (const id of new Set([persisted.baseline, persisted.latest, persisted.recoveryTurns[0].before, persisted.recoveryTurns[0].after])) {
    const manifest = JSON.parse((await gunzipAsync(await readFile(join(ledger.snapshotDir, `${id}.json.gz`)))).toString());
    assert.ok(manifest.createdAt);
    assert.ok(manifest.files["tracked.txt"]);
  }
});

test("lazily migrates a version-1 inline index when its session is opened", async () => {
  const repo = await temporaryDirectory("pi-ledger-migrate-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const original = new ChangedFilesLedger(fakePi(), "session-migrate", repo, cache);
  await original.initialize();
  const draft = await original.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await original.finishTurn(draft);

  const runtime = original.index!;
  const withoutId = ({ id: _id, ...snapshot }: typeof runtime.baseline) => snapshot;
  await rm(original.snapshotDir, { recursive: true, force: true });
  await writeFile(original.indexPath, `${JSON.stringify({
    ...runtime,
    version: 1,
    baseline: withoutId(runtime.baseline),
    latest: withoutId(runtime.latest),
    turns: runtime.recoveryTurns.map((turn) => ({ ...turn, before: withoutId(turn.before), after: withoutId(turn.after) })),
  })}\n`);

  const restored = new ChangedFilesLedger(fakePi(), "session-migrate", repo, cache);
  await restored.initialize();
  const migrated = JSON.parse(await readFile(restored.indexPath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(typeof migrated.baseline, "string");
  assert.equal(typeof migrated.recoveryTurns[0].before, "string");
  assert.equal(restored.index?.recoveryTurns.length, 1);
  assert.equal(restored.sessionStats().files, 1);
  assert.ok((await readdir(restored.snapshotDir)).every((name) => /^[a-f0-9]{64}\.json\.gz$/.test(name)));
});

test("lazily and safely splits version-2 turns into review and recovery histories", async () => {
  const repo = await temporaryDirectory("pi-ledger-v2-migrate-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const original = new ChangedFilesLedger(fakePi(), "session-v2-migrate", repo, cache);
  await original.initialize();
  const draft = await original.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "v2 turn\n");
  await original.finishTurn(draft);
  const persisted = JSON.parse(await readFile(original.indexPath, "utf8"));
  const v2 = { ...persisted, version: 2, turns: persisted.recoveryTurns };
  delete v2.reviewTurns;
  delete v2.recoveryTurns;
  await writeFile(original.indexPath, `${JSON.stringify(v2)}\n`);

  const migrated = new ChangedFilesLedger(fakePi(), "session-v2-migrate", repo, cache);
  await migrated.initialize();
  assert.equal(migrated.index?.version, 3);
  assert.equal(migrated.index?.reviewTurns.length, 1);
  assert.equal(migrated.index?.recoveryTurns.length, 1);
  assert.equal(migrated.index?.reviewTurns[0]?.id, migrated.index?.recoveryTurns[0]?.id);
  assert.equal(migrated.index?.recoveryTurns[0]?.source, undefined, "old turns retain fallback behavior");
  const rewritten = JSON.parse(await readFile(migrated.indexPath, "utf8"));
  assert.equal(rewritten.version, 3);
  assert.equal("turns" in rewritten, false);
});

test("garbage collection keeps recovery roots until explicit history pruning", async () => {
  const repo = await temporaryDirectory("pi-ledger-gc-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-gc", repo, cache);
  await ledger.initialize();
  const draft = await ledger.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await ledger.finishTurn(draft);
  const recoverySnapshotIds = new Set(ledger.index!.recoveryTurns.flatMap((turn) => [turn.before.id!, turn.after.id!]));
  const oldSnapshotIds = new Set((await readdir(ledger.snapshotDir)).map((name) => name.slice(0, -8)));
  const oldBlobNames = new Set(await readdir(ledger.blobDir));

  await ledger.resetBaseline();
  for (const id of recoverySnapshotIds) await access(join(ledger.snapshotDir, `${id}.json.gz`));
  for (const turn of ledger.index!.recoveryTurns) {
    for (const file of Object.values({ ...turn.before.files, ...turn.after.files })) await access(join(ledger.blobDir, `${file.hash}.gz`));
  }
  await ledger.pruneRecoveryHistory();
  const rootedId = ledger.index!.baseline.id!;
  assert.deepEqual(await readdir(ledger.snapshotDir), [`${rootedId}.json.gz`]);
  const rootedBlobs = new Set(Object.values(ledger.index!.baseline.files).map((file) => `${file.hash}.gz`));
  assert.deepEqual(new Set(await readdir(ledger.blobDir)), rootedBlobs);
  assert.ok([...oldSnapshotIds].some((id) => id !== rootedId));
  assert.ok([...oldBlobNames].some((name) => !rootedBlobs.has(name)));
});

test("persists named checkpoints until explicit deletion and roots their manifests and blobs", async () => {
  const repo = await temporaryDirectory("pi-ledger-named-checkpoint-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-named", repo, cache);
  await ledger.initialize();
  await writeFile(join(repo, "tracked.txt"), "named version\n");
  const checkpoint = await ledger.createCheckpoint("named", "before experiment");
  const manifestPath = join(ledger.snapshotDir, `${checkpoint.snapshot.id}.json.gz`);
  const blobPath = join(ledger.blobDir, `${checkpoint.snapshot.files["tracked.txt"]!.hash}.gz`);

  await writeFile(join(repo, "tracked.txt"), "current version\n");
  await ledger.resetBaseline();
  await access(manifestPath);
  await access(blobPath);
  assert.equal(ledger.listCheckpoints()[0]?.name, "before experiment");
  await assert.rejects(ledger.createCheckpoint("named", "before experiment"), /already exists/);

  const reopened = new ChangedFilesLedger(fakePi(), "session-named", repo, cache);
  await reopened.initialize();
  assert.equal(reopened.listCheckpoints()[0]?.snapshot.id, checkpoint.snapshot.id);
  assert.equal(await reopened.deleteCheckpoint("before experiment"), true);
  assert.equal(await reopened.deleteCheckpoint("before experiment"), false);
  await assert.rejects(access(manifestPath), /ENOENT/);
  await assert.rejects(access(blobPath), /ENOENT/);
});

test("retains only the last ten automatic checkpoints without pruning named checkpoints", async () => {
  const repo = await temporaryDirectory("pi-ledger-auto-checkpoint-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-auto", repo, cache);
  await ledger.initialize();
  const named = await ledger.createCheckpoint("named", "keep me");
  const automaticIds: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(repo, "tracked.txt"), `automatic ${index}\n`);
    automaticIds.push((await ledger.createCheckpoint("automatic")).id);
  }

  const checkpoints = ledger.listCheckpoints();
  assert.equal(checkpoints.filter((item) => item.kind === "automatic").length, 10);
  assert.ok(checkpoints.some((item) => item.id === named.id));
  assert.ok(!checkpoints.some((item) => automaticIds.slice(0, 2).includes(item.id)));
  const persisted = JSON.parse(await readFile(ledger.indexPath, "utf8"));
  assert.ok(persisted.checkpoints.every((item: { snapshot: unknown }) => typeof item.snapshot === "string"));
  for (const id of automaticIds.slice(0, 2)) {
    const snapshotId = id.split("-").at(-1)!;
    assert.ok(!(await readdir(ledger.snapshotDir)).some((name) => name.startsWith(snapshotId)));
  }
});

test("promotes an automatic checkpoint in place without copying and pins its provenance and GC roots", async () => {
  const repo = await temporaryDirectory("pi-ledger-promote-checkpoint-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-promote", repo, cache);
  await ledger.initialize();
  await writeFile(join(repo, "tracked.txt"), "safety content\n");
  const automatic = await ledger.createCheckpoint("automatic");
  automatic.sourceLabel = "Before restoring response to fix auth";
  automatic.sourceId = "turn-7";
  const originalId = automatic.id;
  const snapshotId = automatic.snapshot.id!;
  const manifestPath = join(ledger.snapshotDir, `${snapshotId}.json.gz`);
  const blobPath = join(ledger.blobDir, `${automatic.snapshot.files["tracked.txt"]!.hash}.gz`);
  const beforeManifest = await stat(manifestPath);
  const beforeBlob = await stat(blobPath);

  const promoted = await ledger.promoteCheckpoint(originalId, "auth safety");
  assert.equal(promoted, automatic, "the same in-memory record is converted");
  assert.equal(promoted.id, originalId);
  assert.equal(promoted.snapshot.id, snapshotId);
  assert.equal(promoted.sourceLabel, "Before restoring response to fix auth");
  assert.equal(promoted.sourceId, "turn-7");
  assert.equal(promoted.kind, "named");
  assert.equal((await stat(manifestPath)).ino, beforeManifest.ino, "manifest is not copied");
  assert.equal((await stat(blobPath)).ino, beforeBlob.ino, "blob is not copied");

  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(repo, "tracked.txt"), `roll ${index}\n`);
    await ledger.createCheckpoint("automatic");
  }
  assert.ok(ledger.listCheckpoints().some((item) => item.id === originalId), "promotion removes it from automatic rolling retention");
  await ledger.resetBaseline();
  await access(manifestPath);
  await access(blobPath);
  const persisted = JSON.parse(await readFile(ledger.indexPath, "utf8"));
  const record = persisted.checkpoints.find((item: { id: string }) => item.id === originalId);
  assert.deepEqual({ id: record.id, kind: record.kind, name: record.name, snapshot: record.snapshot, sourceId: record.sourceId }, {
    id: originalId, kind: "named", name: "auth safety", snapshot: snapshotId, sourceId: "turn-7",
  });
});

test("promotion validates automatic identity and unique labels", async () => {
  const repo = await temporaryDirectory("pi-ledger-promote-validation-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-promote-validation", repo, cache);
  await ledger.initialize();
  const automatic = await ledger.createCheckpoint("automatic");
  await ledger.createCheckpoint("named", "existing");
  await assert.rejects(ledger.promoteCheckpoint(automatic.id, "existing"), /already exists/);
  await assert.rejects(ledger.promoteCheckpoint("missing", "new"), /not found/);
  await ledger.promoteCheckpoint(automatic.id, "promoted");
  await assert.rejects(ledger.promoteCheckpoint(automatic.id, "again"), /already named/);
});

test("global retention never silently prunes a session containing a named checkpoint", async () => {
  const repo = await temporaryDirectory("pi-ledger-pinned-session-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const pinned = join(cache, "old-pinned");
  await mkdir(pinned);
  await writeFile(join(pinned, "index.json"), JSON.stringify({ checkpoints: [{ kind: "named" }] }));
  for (let index = 0; index < 21; index += 1) {
    const path = join(cache, `ordinary-${index}`);
    await mkdir(path);
    await writeFile(join(path, "index.json"), JSON.stringify({ checkpoints: [] }));
  }

  const ledger = new ChangedFilesLedger(fakePi(), "active-session", repo, cache);
  await ledger.initialize();
  await access(pinned);
  assert.ok((await readdir(cache)).length <= 21, "ordinary sessions should still be pruned toward the count cap");
});

test("reports deduplicated named storage and warns at 250 MiB", async () => {
  const repo = await temporaryDirectory("pi-ledger-checkpoint-storage-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-storage", repo, cache);
  await ledger.initialize();
  const first = await ledger.createCheckpoint("named", "one");
  await ledger.createCheckpoint("named", "two");
  const blobPath = join(ledger.blobDir, `${first.snapshot.files["tracked.txt"]!.hash}.gz`);
  await truncate(blobPath, NAMED_CHECKPOINT_WARNING_BYTES);

  const report = await ledger.checkpointStorageReport();
  assert.deepEqual({ checkpoints: report.checkpoints, named: report.named, automatic: report.automatic }, {
    checkpoints: 2,
    named: 2,
    automatic: 0,
  });
  assert.equal(report.warningBytes, NAMED_CHECKPOINT_WARNING_BYTES);
  assert.equal(report.warning, true);
  assert.ok(report.namedBytes >= NAMED_CHECKPOINT_WARNING_BYTES);
  assert.ok(report.namedBytes < NAMED_CHECKPOINT_WARNING_BYTES * 2, "shared blobs must be counted once");
});

test("rollback previews current-to-checkpoint changes and requires explicit confirmation", async () => {
  const repo = await temporaryDirectory("pi-ledger-rollback-confirm-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-rollback-confirm", repo, cache);
  await ledger.initialize();
  const checkpoint = await ledger.createCheckpoint("named", "good");
  await writeFile(join(repo, "tracked.txt"), "bad\n");
  const preview = await ledger.previewRollback(checkpoint.id);
  assert.equal(preview.scope.before.files["tracked.txt"]?.hash === checkpoint.snapshot.files["tracked.txt"]?.hash, false);
  assert.equal(preview.scope.after.id, checkpoint.snapshot.id);
  assert.equal(preview.scope.stats.files, 1);
  assert.match(await readFile(await ledger.writePatch(preview.scope), "utf8"), /-bad|\+initial/);
  await assert.rejects(ledger.rollback(preview, {} as never, 0), /explicit confirmation/);
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "bad\n");
});

test("rollback restores deletes, symlinks, executable modes, and records safety and audit history", async () => {
  const repo = await temporaryDirectory("pi-ledger-rollback-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  await writeFile(join(repo, "script.sh"), "#!/bin/sh\necho good\n");
  await chmod(join(repo, "script.sh"), 0o755);
  await symlink("tracked.txt", join(repo, "link"));
  await writeFile(join(repo, "remove-me.txt"), "checkpoint only\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  const ledger = new ChangedFilesLedger(fakePi(), "session-rollback", repo, cache);
  await ledger.initialize();
  const checkpoint = await ledger.createCheckpoint("named", "known-good");

  await writeFile(join(repo, "script.sh"), "broken\n");
  await chmod(join(repo, "script.sh"), 0o644);
  await rm(join(repo, "link"));
  await writeFile(join(repo, "link"), "not a link\n");
  await rm(join(repo, "remove-me.txt"));
  await writeFile(join(repo, "new-file.txt"), "must disappear\n");
  const preview = await ledger.previewRollback("known-good");
  const beforeTurnCount = ledger.index!.recoveryTurns.length;
  const result = await ledger.rollback(preview, { confirmed: true }, 7);

  assert.equal(await readFile(join(repo, "script.sh"), "utf8"), "#!/bin/sh\necho good\n");
  assert.equal((await lstat(join(repo, "script.sh"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(repo, "link"))).isSymbolicLink(), true);
  assert.equal(await readlink(join(repo, "link")), "tracked.txt");
  assert.equal(await readFile(join(repo, "remove-me.txt"), "utf8"), "checkpoint only\n");
  await assert.rejects(access(join(repo, "new-file.txt")), /ENOENT/);
  assert.equal(result.safetyCheckpoint.kind, "automatic");
  assert.equal(result.safetyCheckpoint.sourceLabel, "Before restoring Restore checkpoint known-good");
  assert.equal(result.safetyCheckpoint.sourceId, checkpoint.id);
  assert.deepEqual(result.safetyCheckpoint.snapshot.files, preview.current.files);
  assert.equal(ledger.index!.recoveryTurns.length, beforeTurnCount + 1);
  assert.equal(ledger.index!.recoveryTurns.at(-1)?.id, result.turn.id);
  assert.equal(result.turn.turnIndex, 7);
  assert.deepEqual(result.turn.before.files, preview.current.files);
  assert.deepEqual(result.turn.after.files, checkpoint.snapshot.files);
  assert.ok(ledger.listCheckpoints().some((item) => item.id === checkpoint.id), "history and target checkpoint remain intact");
});

test("restore refuses to recursively delete an excluded non-empty directory", async () => {
  const repo = await temporaryDirectory("pi-ledger-directory-guard-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  await writeFile(join(repo, "collision"), "tracked file\n");
  await execFileAsync("git", ["add", "collision"], { cwd: repo });
  const ledger = new ChangedFilesLedger(fakePi(), "session-directory-guard", repo, cache);
  await ledger.initialize();
  const checkpoint = await ledger.createCheckpoint("named", "file target");

  await execFileAsync("git", ["rm", "--cached", "-q", "collision"], { cwd: repo });
  await rm(join(repo, "collision"));
  await mkdir(join(repo, "collision"));
  const excludedFifo = join(repo, "collision", "excluded-fifo");
  await execFileAsync("mkfifo", [excludedFifo]);
  const preview = await ledger.previewRollback(checkpoint.id);
  await assert.rejects(ledger.rollback(preview, { confirmed: true }, 0), /Restore failed/);
  assert.equal((await lstat(excludedFifo)).isFIFO(), true);
  assert.ok(ledger.listCheckpoints().some((item) => item.kind === "automatic"), "durable safety checkpoint remains");
});

test("rejects unsafe paths returned by Git without reading outside the worktree", async () => {
  const root = await temporaryDirectory("pi-ledger-path-guard-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  const outside = join(root, "..", "outside-secret.txt");
  await writeFile(outside, "outside\n");
  const ledger = new ChangedFilesLedger(listingPi(root, ["../outside-secret.txt"]), "session-path-guard", root, cache);
  await assert.rejects(ledger.initialize(), /Unsafe ledger path/);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  await rm(outside, { force: true });
});

test("rollback rejects a stale preview before creating a safety checkpoint or changing files", async () => {
  const repo = await temporaryDirectory("pi-ledger-rollback-stale-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-rollback-stale", repo, cache);
  await ledger.initialize();
  await ledger.createCheckpoint("named", "target");
  await writeFile(join(repo, "tracked.txt"), "previewed\n");
  const preview = await ledger.previewRollback("target");
  await writeFile(join(repo, "tracked.txt"), "newer\n");
  const count = ledger.listCheckpoints().length;
  await assert.rejects(ledger.rollback(preview, { confirmed: true }, 1), /changed after the restore preview/);
  assert.equal(ledger.listCheckpoints().length, count);
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "newer\n");
});

test("turn restoration supports after/undo semantics, external divergence, no-op, and last eligibility", async () => {
  const repo = await temporaryDirectory("pi-ledger-turn-restore-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-turn-restore", repo, cache);
  await ledger.initialize();
  const first = await ledger.beginTurn(0, 1000);
  await writeFile(join(repo, "tracked.txt"), "after one\n");
  const turnOne = await ledger.finishTurn(first, 2000);
  const second = await ledger.beginTurn(1, 3000);
  await writeFile(join(repo, "tracked.txt"), "after two\n");
  const turnTwo = await ledger.finishTurn(second, 4000);

  await writeFile(join(repo, "tracked.txt"), "external edit\n");
  const undo = await ledger.previewRestore({ id: turnTwo.id, label: "pre-state of turn 2", action: "undo", snapshot: turnTwo.before });
  assert.equal(undo.divergence.files, 1);
  assert.equal(undo.scope.before.files["tracked.txt"]?.hash === turnTwo.after.files["tracked.txt"]?.hash, false, "preview starts at actual workspace");
  const restored = await ledger.rollback(undo, { confirmed: true }, 2, 5000);
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "after one\n");
  assert.equal(restored.turn.kind, "restoration");
  assert.deepEqual(restored.turn.restoration, { target: "pre-state of turn 2", action: "undo", divergenceFiles: 1 });
  assert.equal((await ledger.latestEligibleTurn())?.id, turnOne.id, "audit turn and already-undone turn are ineligible");

  const noOp = await ledger.previewRestore({ id: turnOne.id, label: "after turn 1", action: "after", snapshot: turnOne.after });
  assert.equal(noOp.scope.stats.files, 0);
  const checkpointCount = ledger.listCheckpoints().length;
  await assert.rejects(ledger.rollback(noOp, { confirmed: true }, 3), /already the current state/);
  assert.equal(ledger.listCheckpoints().length, checkpointCount, "no-op creates no fake safety checkpoint");
});

test("clears only diff review history and preserves restoration targets and checkpoints", async () => {
  const repo = await temporaryDirectory("pi-ledger-reset-");
  const cache = await temporaryDirectory("pi-ledger-cache-");
  await initRepo(repo);
  const ledger = new ChangedFilesLedger(fakePi(), "session-reset", repo, cache);
  await ledger.initialize();

  const draft = await ledger.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  const retainedTurn = await ledger.finishTurn(draft);
  const named = await ledger.createCheckpoint("named", "keep landmark");
  const automatic = await ledger.createCheckpoint("automatic");
  assert.equal(ledger.index?.reviewTurns.length, 1);
  assert.equal(ledger.index?.recoveryTurns.length, 1);
  assert.equal(ledger.sessionStats().files, 1);

  const baseline = await ledger.resetBaseline();
  assert.equal(ledger.index?.reviewTurns.length, 0);
  assert.equal(ledger.index?.recoveryTurns.length, 1);
  assert.equal(ledger.genuineAgentTurns()[0]?.id, retainedTurn.id);
  assert.deepEqual(new Set(ledger.listCheckpoints().map((item) => item.id)), new Set([named.id, automatic.id]));
  assert.deepEqual(changedPaths(baseline, ledger.index!.latest), []);
  assert.equal(ledger.sessionStats().files, 0);
  assert.match(await readFile(ledger.patchPath, "utf8"), /Diff history cleared/);

  const removed = await ledger.pruneRecoveryHistory();
  assert.equal(removed.agentTurns, 1);
  assert.equal(removed.namedCheckpoints, 1);
  assert.equal(removed.automaticCheckpoints, 1);
  assert.equal(ledger.index?.recoveryTurns.length, 0);
  assert.deepEqual(new Set(ledger.listCheckpoints().map((item) => item.id)), new Set([named.id, automatic.id]));

  const nextDraft = await ledger.beginTurn(0);
  await writeFile(join(repo, "tracked.txt"), "changed again\n");
  const nextRecord = await ledger.finishTurn(nextDraft);
  assert.equal(nextRecord.stats.files, 1);
  assert.equal(ledger.sessionStats().files, 1);
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
