import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ScratchStore } from "./store.ts";
import { formatSelection } from "./editing.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), "bb-scratch-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const store = new ScratchStore(join(base, "data"), join(base, "home"), join(base, "state"));
  return { base, root, store };
}

test("notes stay outside the workspace and are private; concurrent saves conflict", async t => {
  const { base, root, store } = await fixture(t);
  const initial = await store.load(root);
  assert.equal(initial.text, "");
  const results = await Promise.allSettled([
    store.save(root, "first", initial.revision),
    store.save(root, "second", initial.revision),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const saved = await store.load(root);
  const winner = results.find(r => r.status === "fulfilled");
  assert.ok(winner && winner.status === "fulfilled");
  assert.equal(saved.text, winner.value.text);
  const key = createHash("sha256").update(root).digest("hex");
  assert.equal((await stat(join(base, "data/scratch", key))).mode & 0o777, 0o700);
  assert.equal((await stat(join(base, "data/scratch", key, "scratch.md"))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(root, ".agents/project-journal.md")), { code: "ENOENT" });
});

test("Git subdirectories share notes; other workspaces remain independent", async t => {
  const { base, root, store } = await fixture(t);
  execFileSync("git", ["init", "-q", root]);
  const sub = join(root, "src"); await mkdir(sub);
  const initial = await store.load(sub);
  assert.equal(initial.root, root);
  await store.save(sub, "workspace notes", initial.revision);
  assert.equal((await store.load(root)).text, "workspace notes");
  const other = join(base, "other"); await mkdir(other);
  assert.equal((await store.load(other)).text, "");
  await assert.rejects(store.save(other, "wrong workspace", initial.revision, root), /Workspace changed/);
  assert.equal((await store.load(other)).text, "");
});

test("imports Herdr once, does not change its original, and does not reimport after clear", async t => {
  const { base, root, store } = await fixture(t);
  const key = createHash("sha256").update(root).digest("hex");
  const original = join(base, "state/herdr/project-scratch", key, "scratch.md");
  await mkdir(join(original, ".."), { recursive: true });
  await writeFile(original, "old notes");
  const imported = await store.load(root);
  assert.equal(imported.imported, true);
  assert.equal(imported.text, "old notes");
  await store.save(root, "", imported.revision);
  assert.equal((await store.load(root)).text, "");
  assert.equal(await readFile(original, "utf8"), "old notes");
});

test("preview does not write; promotion appends exactly once and keeps scratch", async t => {
  const { root, store } = await fixture(t);
  const initial = await store.load(root);
  await store.save(root, "private\nselected", initial.revision);
  const preview = await store.preview(root, "selected");
  await assert.rejects(readFile(preview.path), { code: "ENOENT" });
  await store.promote(root, preview.token);
  assert.equal(await readFile(preview.path, "utf8"), preview.append);
  await store.promote(root, preview.token);
  assert.equal(await readFile(preview.path, "utf8"), preview.append);
  assert.equal((await store.load(root)).text, "private\nselected");
});

test("stale previews refuse to overwrite a journal changed by another writer", async t => {
  const { root, store } = await fixture(t);
  const preview = await store.preview(root, "decision");
  await mkdir(join(root, ".agents"));
  await writeFile(preview.path, "external update");
  await assert.rejects(store.promote(root, preview.token), /journal changed/i);
  assert.equal(await readFile(preview.path, "utf8"), "external update");
  const fresh = await store.preview(root, "decision");
  await store.promote(root, fresh.token);
  assert.equal(await readFile(fresh.path, "utf8"), "external update" + fresh.append);
});

test("promotion is bound to its workspace; reloaded workers require a new preview", async t => {
  const { base, root, store } = await fixture(t);
  const preview = await store.preview(root, "decision");
  const other = join(base, "other"); await mkdir(other);
  await assert.rejects(store.promote(other, preview.token), /preview expired/i);
  const reloaded = new ScratchStore(join(base, "data"));
  await assert.rejects(reloaded.promote(root, preview.token), /preview expired/i);
});

test("refuses journal symlinks and symlinked .agents directories", async t => {
  const { base, root, store } = await fixture(t);
  const outside = join(base, "outside"); await mkdir(outside);
  await symlink(outside, join(root, ".agents"));
  await assert.rejects(store.preview(root, "decision"), /real directory/i);
  await rm(join(root, ".agents")); await mkdir(join(root, ".agents"));
  const target = join(outside, "journal.md"); await writeFile(target, "keep");
  await symlink(target, join(root, ".agents/project-journal.md"));
  await assert.rejects(store.preview(root, "decision"));
  assert.equal(await readFile(target, "utf8"), "keep");
});

test("oversized and blank input is rejected without replacing saved notes", async t => {
  const { root, store } = await fixture(t);
  const initial = await store.load(root);
  await assert.rejects(store.save(root, "é".repeat(300_000), initial.revision), /512 KiB/);
  await assert.rejects(store.preview(root, "  "), /write a note/);
  assert.equal((await store.load(root)).text, "");
});

test("todo cycles preserve indent; formatting only changes selected lines or text", () => {
  let result = formatSelection("  task\nother", 2, 2, "todo");
  assert.equal(result.text, "  - [ ] task\nother");
  result = formatSelection(result.text, 2, 2, "todo");
  assert.equal(result.text, "  - [x] task\nother");
  result = formatSelection(result.text, 2, 2, "todo");
  assert.equal(result.text, "  task\nother");
  assert.equal(formatSelection("one\ntwo", 0, 4, "todo").text, "- [ ] one\ntwo");
  assert.equal(formatSelection("one two", 4, 7, "strike").text, "one ~~two~~");
  assert.equal(formatSelection("one ~~two~~", 4, 11, "strike").text, "one two");
});
