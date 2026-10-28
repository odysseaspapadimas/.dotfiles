import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTasks } from "./host.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() { const d = await mkdtemp(join(tmpdir(), "agent-todos-")); dirs.push(d); return d; }
const entry = (tasks: unknown[], id = "a", parentId: string | null = null) =>
  JSON.stringify({ type: "custom", id, parentId, customType: "rpiv-todo-state", data: { tasks, nextId: 2 } }) + "\n";
test("reads snapshots and invalidates cached state on append", async () => {
  const d = await fixture();
  const t = { id: 1, subject: "Test", status: "pending" };
  await writeFile(join(d, "pi_test.jsonl"), entry([t]));
  expect(await readTasks("pi_test", d)).toEqual({ tasks: [t], error: null });
  await appendFile(join(d, "pi_test.jsonl"), entry([], "b", "a"));
  expect(await readTasks("pi_test", d)).toEqual({ tasks: [], error: null });
});
test("ignores concurrent partial final lines then reads them when complete", async () => {
  const d = await fixture();
  await writeFile(join(d, "pi_test.jsonl"), entry([]) + '{"type":"message"');
  expect(await readTasks("pi_test", d)).toEqual({ tasks: [], error: null });
  await appendFile(join(d, "pi_test.jsonl"), ',"id":"b","parentId":"a"}\n');
  expect(await readTasks("pi_test", d)).toEqual({ tasks: [], error: null });
});
test("denies traversal and reports missing or malformed files without leaking paths", async () => {
  const d = await fixture();
  await expect(readTasks("../secret", d)).rejects.toThrow();
  expect((await readTasks("missing", d)).error).toBeTruthy();
  await writeFile(join(d, "pi_test.jsonl"), "{bad}\n");
  const result = await readTasks("pi_test", d);
  expect(result.error).toBeTruthy();
  expect(result.error).not.toContain(d);
});
