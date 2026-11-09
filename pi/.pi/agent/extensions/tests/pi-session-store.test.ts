import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { METADATA_TYPE, SessionStore } from "../pi-sessions/store.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const entry = (id: string, parentId: string | null, fields: object) => ({ id, parentId, timestamp, ...fields });
const header = (extra = {}) => ({ type: "session", version: 3, id: "store-fixture", cwd: "/tmp/store-fixture", timestamp, ...extra });
const assistant = (provider: string, model: string) => ({ role: "assistant", provider, model,
  content: [{ type: "text", text: "private transcript body" }], timestamp: Date.parse(timestamp), stopReason: "stop" });

async function fixture(t: { after(fn: () => Promise<void>): void }, entries: object[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const path = join(root, "project", "fixture.jsonl");
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { root, path };
}

class MetadataOnlyStore extends SessionStore {
  override async load(): Promise<never> { throw new Error("Catalogue discovery must not load a transcript"); }
}

test("catalogue streams metadata without transcript loads or LRU retention; native branch/name semantics match", async (t) => {
  const { root, path } = await fixture(t, [
    header(),
    entry("metadata", null, { type: "custom", customType: METADATA_TYPE, data: {
      id: "owned-fixture", sessionId: "store-fixture", createdAt: 123, parentSessionId: "parent", lifecycle: "task",
      initialProvider: "initial", initialModel: "initial-model", initialThinking: "low",
    } }),
    entry("model", "metadata", { type: "model_change", provider: "selected", modelId: "selected-model" }),
    entry("thinking", "model", { type: "thinking_level_change", thinkingLevel: "high" }),
    entry("answer", "thinking", { type: "message", message: assistant("physical", "physical-model") }),
    entry("tool", "answer", { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(100_000) }] } }),
    entry("checkpoint", "tool", { type: "compaction", summary: "private summary", details: { replacementHistory: "y".repeat(100_000) } }),
    entry("wrong-model", "model", { type: "model_change", provider: "abandoned", modelId: "abandoned" }),
    entry("wrong-thinking", "wrong-model", { type: "thinking_level_change", thinkingLevel: "off" }),
    // Names are session-wide, but model/thinking come from the active ancestry.
    entry("name", "wrong-thinking", { type: "session_info", name: "Session-wide name" }),
    entry("leaf", "checkpoint", { type: "context_edit", targetId: "answer", replacement: null }),
  ]);
  const expected = (await new SessionStore(root, null).load(path)).session;
  const store = new MetadataOnlyStore(root, null);
  assert.deepEqual(await store.list(), [expected]);
  assert.equal(expected.provider, "physical");
  assert.equal(expected.model, "physical-model");
  assert.equal(expected.thinking, "high");
  assert.equal(expected.name, "Session-wide name");
  assert.equal(expected.parentSessionId, "parent");
  assert.equal((store as any).cache.size, 0);
  assert.equal((store as any).bytes, 0);
});

test("cloned metadata cannot acquire the original session's ownership", async (t) => {
  const { root, path } = await fixture(t, [
    header({ id: "clone", parentSession: "/tmp/original.jsonl" }),
    entry("copied", null, { type: "custom", customType: METADATA_TYPE, data: {
      id: "original-owned", sessionId: "original", lifecycle: "task", parentSessionId: "original-parent",
    } }),
    entry("copied-legacy", "copied", { type: "custom", customType: METADATA_TYPE, data: { id: "unbound-original" } }),
    entry("answer", "copied-legacy", { type: "message", message: assistant("test", "model") }),
  ]);
  const expected = (await new SessionStore(root, null).load(path)).session;
  assert.deepEqual(await new MetadataOnlyStore(root, null).list(), [expected]);
  assert.equal(expected.id, "clone");
  assert.equal(expected.orchestrated, false);
  assert.equal(expected.parentSessionId, undefined);
});

test("changed files and warm disk indexes refresh metadata without loading bodies; index contains no transcripts", async (t) => {
  const { root, path } = await fixture(t, [header(), entry("answer", null, { type: "message", message: assistant("one", "first") })]);
  const index = join(root, "index.json");
  const store = new MetadataOnlyStore(root, index);
  assert.equal((await store.list())[0].model, "first");
  await appendFile(path, JSON.stringify(entry("new-model", "answer", { type: "model_change", provider: "two", modelId: "second" })) + "\n");
  assert.equal((await store.list())[0].model, "second");
  const warm = new MetadataOnlyStore(root, index);
  assert.deepEqual(await warm.list(), await store.list());
  const disk = await readFile(index, "utf8");
  assert.equal(disk.includes("private transcript body"), false);
  assert.equal(disk.includes('"messages"'), false);
  // Replacement must invalidate even when the same path is reused.
  await writeFile(path + ".replacement", JSON.stringify(header({ id: "replacement" })) + "\n");
  await rename(path + ".replacement", path);
  assert.equal((await warm.list())[0].sessionId, "replacement");
});

test("legacy files use native in-memory migration and are never rewritten", async (t) => {
  for (const version of [1, 2]) {
    const { root, path } = await fixture(t, [
      header({ version }),
      entry("name", null, { type: "session_info", name: "Legacy" }),
      entry("answer", "name", { type: "message", message: assistant("legacy", "legacy-model") }),
    ]);
    const original = await readFile(path, "utf8");
    const expected = (await new SessionStore(root, null).load(path)).session;
    assert.deepEqual(await new SessionStore(root, null).list(), [expected]);
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("malformed lines do not hide healthy metadata; corrupt sessions/indexes remain disposable", async (t) => {
  const { root, path } = await fixture(t, [header(), entry("name", null, { type: "session_info", name: "Healthy" })]);
  await appendFile(path, "{truncated\n\n");
  await writeFile(join(root, "project", "invalid.jsonl"), '{"type":"message"}\n');
  const index = join(root, "index.json");
  await writeFile(index, "{broken");
  assert.equal((await new MetadataOnlyStore(root, index).list())[0].name, "Healthy");
});

test("cancellation during metadata streaming propagates and closes the reader", async (t) => {
  const { root, path } = await fixture(t, [header()]);
  await appendFile(path, Array.from({ length: 3000 }, (_, i) => JSON.stringify(entry(`e${i}`, i ? `e${i - 1}` : null,
    { type: "custom", customType: "irrelevant", data: "x".repeat(1024) }))).join("\n") + "\n");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 2);
  try { await assert.rejects(new MetadataOnlyStore(root, null).list(abort.signal), { name: "AbortError" }); }
  finally { clearTimeout(timer); }
});

test("transcript LRU charges source backing storage, not only tiny visible messages", async (t) => {
  const { root, path } = await fixture(t, [header(), entry("answer", null, { type: "message", message: assistant("test", "model") })]);
  // A large ignored body/whitespace still occupies source backing memory while
  // parsing. Keep this a synthetic file, never a real session or private dump.
  await appendFile(path, " ".repeat(17 * 1024 * 1024));
  const store = new SessionStore(root, null);
  const first = await store.load(path);
  assert.equal(first.messages[0].text, "private transcript body");
  assert.equal((store as any).cache.size, 0);
  assert.notEqual(await store.load(path), first);
});
