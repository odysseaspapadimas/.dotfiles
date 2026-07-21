import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournalAtomically, atomicPrivateWrite, prepareProjectScratch, promotionAppend, resolveProjectScratch } from "../src/storage.js";

test("isolates canonical projects in private hashed state", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-scratch-"));
  const one = join(base, "one"), two = join(base, "two"), stateRoot = join(base, "state");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(one), mkdir(two)]));
  const a = await resolveProjectScratch(one, stateRoot), b = await resolveProjectScratch(two, stateRoot);
  assert.notEqual(a.key, b.key);
  assert.equal(a.scratchPath.startsWith(one), false);
  await prepareProjectScratch(a);
  const metadata = JSON.parse(await readFile(a.metadataPath, "utf8"));
  assert.equal(metadata.root, a.canonicalRoot);
});

test("atomic scratch writes are private", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-scratch-write-"));
  const path = join(base, "nested", "scratch.md");
  await atomicPrivateWrite(path, "secret\n");
  assert.equal(await readFile(path, "utf8"), "secret\n");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("promotion previews exact dated append and appends without copying private storage", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-scratch-promote-"));
  const append = promotionAppend("chosen text\n", new Date("2026-04-05T12:00:00Z"));
  assert.equal(append, "\n\n## 2026-04-05\n\nchosen text\n");
  const journal = await appendJournalAtomically(base, append);
  await appendJournalAtomically(base, promotionAppend("second", new Date("2026-04-06T00:00:00Z")));
  assert.equal(await readFile(journal, "utf8"), "\n\n## 2026-04-05\n\nchosen text\n\n\n## 2026-04-06\n\nsecond\n");
});
