import { z } from "zod";
import { taskSchema, type Task } from "./contract.ts";

const snapshotSchema = z.object({
  tasks: z.array(taskSchema).max(1000),
  nextId: z.number(),
});
type Link = { parentId: string | null; custom?: Task[]; tool?: Task[] };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

// Pi v3 JSONL is a tree, not a linear transcript. Follow the latest persisted
// leaf and give commit-time custom snapshots priority over tool-result echoes,
// matching rpiv-todo's own replay semantics. Never retain conversation content.
export function tasksFromSession(text: string): Task[] {
  const links = new Map<string, Link>();
  let leaf: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown> | null;
    try { e = record(JSON.parse(line)); } catch {
      throw new Error("Invalid session entry");
    }
    if (!e || e.type === "session" || typeof e.id !== "string") continue;
    const link: Link = { parentId: typeof e.parentId === "string" ? e.parentId : null };
    const message = record(e.message);
    const isCustom = e.type === "custom" && e.customType === "rpiv-todo-state";
    const isTool = e.type === "message" && message?.role === "toolResult" && message.toolName === "todo";
    if (isCustom || isTool) {
      const snapshot = snapshotSchema.safeParse(isCustom ? e.data : message?.details);
      if (snapshot.success) {
        if (isCustom) link.custom = snapshot.data.tasks;
        else link.tool = snapshot.data.tasks;
      } else if (isCustom) throw new Error("Unsupported task snapshot");
    }
    links.set(e.id, link);
    leaf = e.id;
  }
  let fromTool: Task[] | undefined;
  const visited = new Set<string>();
  while (leaf !== null) {
    if (visited.has(leaf)) throw new Error("Session branch cycle");
    visited.add(leaf);
    const link = links.get(leaf);
    if (!link) throw new Error("Incomplete session branch");
    if (link.custom) return link.custom.filter(task => task.status !== "deleted");
    fromTool ??= link.tool;
    leaf = link.parentId;
  }
  return (fromTool ?? []).filter(task => task.status !== "deleted");
}
