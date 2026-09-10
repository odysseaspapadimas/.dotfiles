import type { SessionSnapshot, SettledRun } from "./store.ts";

/** Cancel this waiter without cancelling a shared monitor's work. */
export function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {}); // The shared operation can still fail after this waiter leaves.
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export function runState(snapshot: SessionSnapshot, runtimeStatus: string, pinnedUserId?: string) {
  const { messages } = snapshot;
  const user = messages.findLast((entry) => entry.role === "user");
  const runId = pinnedUserId ?? user?.id;
  const marker = snapshot.settled.findLast((entry) => entry.userEntryId === runId);
  const markedAssistant = marker && messages.find((entry) => entry.id === marker.assistantEntryId && entry.role === "assistant");
  const latest = messages.findLast((entry) => entry.role === "assistant");
  // A durable marker identifies the actual run, including after its runtime was closed.
  if (marker && markedAssistant) return { runId, outcome: marker.outcome, latest: markedAssistant, durable: true };
  if (pinnedUserId && user?.id !== pinnedUserId) return { runId, outcome: "superseded" as const, latest, durable: false };
  // Compatibility for sessions whose runtime has not loaded the settled hook yet.
  // Never infer a historical completion from timestamps or from a tool-use message.
  if (user && latest && messages.indexOf(latest) > messages.indexOf(user) &&
      (runtimeStatus === "idle" || runtimeStatus === "done")) {
    const reason = latest.stopReason;
    const outcome: SettledRun["outcome"] | undefined = reason === "error" || reason === "length" ? "failed" :
      reason === "aborted" ? "aborted" : reason === "stop" ? "completed" : undefined;
    if (outcome) return { runId, outcome, latest, durable: false };
  }
  return { runId, outcome: undefined, latest, durable: false };
}
