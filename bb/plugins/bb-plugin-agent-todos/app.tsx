import { useEffect, useId, useState } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { Result, rpcContract } from "./contract.ts";
import "./tasks.css";

export function TaskList({ result }: { result: Result }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const tasks = result.tasks.filter(task => task.status !== "deleted");
  if (!tasks.length) return null;
  const completed = tasks.filter(task => task.status === "completed").length;
  const current = tasks.find(task => task.status === "in_progress");
  const summary = current?.activeForm || current?.subject ||
    (completed === tasks.length ? "All tasks completed" : tasks.find(task => task.status === "pending")?.subject);
  return <section className="agent-todos" aria-label="Agent tasks">
    <button type="button" className="agent-todos-toggle" aria-expanded={expanded}
      aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <span className="agent-todos-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      <span className="agent-todos-summary">{summary}</span>
      <span className="agent-todos-count">{completed}/{tasks.length}</span>
    </button>
    {result.error && <div className="agent-todos-error" role="status">{result.error} Showing last known tasks.</div>}
    {expanded && <ol id={id} className="agent-todos-list">
      {tasks.map(task => <li key={task.id} data-status={task.status}
        title={task.description || task.subject}>
        <span className="agent-todos-marker" aria-label={task.status.replace("_", " ")}>
          {task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
        </span>
        <span>{task.subject}{task.blockedBy?.length ? <small> · depends on {task.blockedBy.map(id => "#" + id).join(", ")}</small> : null}</span>
      </li>)}
    </ol>}
  </section>;
}

export function ThreadTasks({ threadId, running }: { threadId: string; running: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<Result>({ tasks: [], error: null });
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || controller.signal.aborted || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const next = await rpc.call("tasks", { threadId });
        if (!controller.signal.aborted) setResult(previous =>
          next.error ? { tasks: previous.tasks, error: next.error } : next);
      } catch {
        if (!controller.signal.aborted) setResult(previous => ({
          tasks: previous.tasks, error: "Task updates unavailable. Retrying…",
        }));
      } finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, running ? 2000 : 10000);
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [rpc, threadId, running]);
  return <TaskList result={result} />;
}
export function ComposerTasks() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread" || composer.selection?.providerId !== "pi") return null;
  return <ThreadTasks key={composer.scope.threadId} threadId={composer.scope.threadId} running={composer.isRunning} />;
}
export default definePluginApp(app => {
  app.composer.customize({
    id: "agent-todos", scopes: ["thread"],
    banners: [{ id: "tasks", chrome: "bare", component: ComposerTasks }],
  });
});
