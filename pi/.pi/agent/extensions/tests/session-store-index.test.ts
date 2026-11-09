import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, rename, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "../pi-sessions/store.ts";

class CountingStore extends SessionStore {
  metadataReads = 0;
  loads = 0;
  protected override async loadMetadata(path: string, updatedAt: number, signal?: AbortSignal) {
    this.metadataReads++;
    return super.loadMetadata(path, updatedAt, signal);
  }
  override async load(...args: Parameters<SessionStore["load"]>) {
    this.loads++;
    return super.load(...args);
  }
}
async function fixture(run: (root: string, index: string, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-index-"));
  const root = join(directory, "sessions");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const session = SessionManager.create(directory, project);
  session.appendSessionInfo("Original");
  const path = session.getSessionFile()!;
  await writeFile(path, [session.getHeader(), ...session.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  try { await run(root, join(directory, "cache", "index.json"), path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("fresh stores reuse metadata without parsing transcripts; direct reads still load them", async () => {
  await fixture(async (root, index, path) => {
    const before = await readFile(path, "utf8");
    const initial = new CountingStore(root, index);
    const expected = await initial.list();
    assert.equal(initial.metadataReads, 1);
    assert.equal(initial.loads, 0, "cold catalogue reads do not inflate a transcript");
    const fresh = new CountingStore(root, index);
    assert.deepEqual(await fresh.list(), expected);
    assert.equal(fresh.metadataReads, 0);
    assert.equal(fresh.loads, 0);
    assert.equal((await stat(index)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(index, "utf8"));
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0][1].messages, undefined, "index contains metadata only");
    await fresh.load(path);
    assert.equal(fresh.loads, 1, "recall/read never substitutes metadata for transcripts");
    assert.equal(await readFile(path, "utf8"), before, "history is never rewritten");
  });
});

test("appends, replacements, deletions and explicit clear invalidate persisted metadata", async () => {
  await fixture(async (root, index, path) => {
    await new SessionStore(root, index).list();
    await appendFile(path, JSON.stringify({ type: "session_info", id: "rename", parentId: null,
      timestamp: new Date().toISOString(), name: "Renamed!" }) + "\n");
    const appended = new CountingStore(root, index);
    assert.equal((await appended.list())[0].name, "Renamed!");
    assert.equal(appended.metadataReads, 1);
    assert.equal(appended.loads, 0);
    const previous = await stat(path);
    const replacement = (await readFile(path, "utf8")).replace("Renamed!", "Replaced");
    await writeFile(path + ".replacement", replacement);
    await utimes(path + ".replacement", previous.atime, previous.mtime);
    await rename(path + ".replacement", path);
    const replaced = new CountingStore(root, index);
    assert.equal((await replaced.list())[0].name, "Replaced");
    assert.equal(replaced.metadataReads, 1, "same-sized replacement with restored mtime has a different identity");
    replaced.clear();
    await replaced.list();
    assert.equal(replaced.metadataReads, 2);
    assert.equal(replaced.loads, 0);
    await rm(path);
    assert.deepEqual(await new SessionStore(root, index).list(), []);
    assert.equal(JSON.parse(await readFile(index, "utf8")).entries.length, 0);
  });
});

test("new files and concurrent writers preserve a complete usable index", async () => {
  await fixture(async (root, index, path) => {
    await new SessionStore(root, index).list();
    const added = join(root, "project", "new.jsonl");
    await writeFile(added, (await readFile(path, "utf8")).replace("Original", "New child"));
    const first = new CountingStore(root, index);
    const second = new CountingStore(root, index);
    const results = await Promise.all([first.list(), second.list()]);
    assert.equal(results[0].length, 2);
    assert.deepEqual(results[0], results[1]);
    assert.ok(first.metadataReads <= 1 && second.metadataReads <= 1, "only the newly added session needs parsing");
    assert.ok(first.metadataReads + second.metadataReads >= 1);
    assert.equal(first.loads + second.loads, 0);
    const fresh = new CountingStore(root, index);
    assert.equal((await fresh.list()).length, 2);
    assert.equal(fresh.metadataReads, 0, "concurrent atomic writes leave a usable index");
    assert.equal(fresh.loads, 0);
  });
});

test("corrupt, incompatible and invalid indexes rebuild; unwritable caching is optional", async () => {
  await fixture(async (root, index, path) => {
    await new SessionStore(root, index).list();
    const valid = JSON.parse(await readFile(index, "utf8"));
    for (const content of ["not json", JSON.stringify({ ...valid, version: 999 }),
      JSON.stringify({ ...valid, root: "/wrong-root" }),
      JSON.stringify({ ...valid, entries: [[path, { ...valid.entries[0][1], session: {} }]] })]) {
      await writeFile(index, content);
      const store = new CountingStore(root, index);
      assert.equal((await store.list())[0].name, "Original");
      assert.equal(store.metadataReads, 1);
      assert.equal(store.loads, 0);
    }
    const unavailable = new CountingStore(root, join(path, "index.json"));
    assert.equal((await unavailable.list()).length, 1, "a cache write failure does not fail listing");
    const disabled = new CountingStore(root, null);
    assert.equal((await disabled.list()).length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(disabled.list(controller.signal), { name: "AbortError" });
  });
});
