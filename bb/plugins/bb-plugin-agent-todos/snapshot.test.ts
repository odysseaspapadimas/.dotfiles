import { expect, test } from "vitest";
import { tasksFromSession } from "./snapshot.ts";
const task = (id = 1, status = "pending") => ({ id, subject: "Task " + id, status });
const custom = (id: string, parentId: string | null, tasks: unknown[]) => ({
  type: "custom", id, parentId, customType: "rpiv-todo-state", data: { tasks, nextId: 5 },
});
const tool = (id: string, parentId: string | null, tasks: unknown[]) => ({
  type: "message", id, parentId, message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 5 } },
});
const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join("\n");
test("empty sessions hide tasks", () => {
  expect(tasksFromSession("")).toEqual([]);
  expect(tasksFromSession(lines({ type: "session", id: "header", version: 3 }))).toEqual([]);
});
test("returns real snapshots including nested calls and excludes tombstones", () => {
  expect(tasksFromSession(lines(custom("a", null, [task(1, "completed"), task(2, "deleted")]))))
    .toEqual([task(1, "completed")]);
});
test("latest snapshot wins, including an explicit clear", () => {
  expect(tasksFromSession(lines(custom("a", null, [task()]), custom("b", "a", [])))).toEqual([]);
});
test("follows branch parents instead of taking latest snapshot from an abandoned branch", () => {
  expect(tasksFromSession(lines(
    custom("a", null, [task()]), custom("b", "a", [task(2)]),
    { type: "message", id: "c", parentId: "a", message: { role: "user", content: "branch" } },
  ))).toEqual([task()]);
});
test("commit snapshots override later stale tool-result echoes", () => {
  expect(tasksFromSession(lines(custom("a", null, [task(1, "completed")]), tool("b", "a", [task()]))))
    .toEqual([task(1, "completed")]);
});
test("older sessions fall back to toolResult details", () => {
  expect(tasksFromSession(lines(tool("a", null, [task()]), tool("b", "a", [task(1, "completed")]))))
    .toEqual([task(1, "completed")]);
});
test("rejects corrupt custom snapshots rather than silently displaying old data", () => {
  expect(() => tasksFromSession(lines(custom("a", null, [{ id: 1, status: "surprise" }])))).toThrow();
});
test("detects cycles, missing parents and malformed JSON", () => {
  expect(() => tasksFromSession(lines({ type: "message", id: "a", parentId: "a" }))).toThrow();
  expect(() => tasksFromSession(lines({ type: "message", id: "a", parentId: "missing" }))).toThrow();
  expect(() => tasksFromSession("{bad}\n")).toThrow();
});
