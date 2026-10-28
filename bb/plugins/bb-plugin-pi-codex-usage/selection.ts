import type { ComposerSelection, PluginComposerScope } from "@get-bb/plugin-sdk";
import type { Target } from "./contract.ts";

export function isPiOpenAI(selection: ComposerSelection | null): boolean {
  return selection?.providerId === "pi" && /^(openai|openai-codex)\//.test(selection.model ?? "");
}
export function usageTarget(scope: PluginComposerScope, selection: ComposerSelection | null): Target | null {
  if (scope.kind !== "new-thread") return { kind: "thread", threadId: scope.threadId };
  const env = selection?.environment;
  if (env?.type === "reuse") return { kind: "environment", environmentId: env.environmentId };
  if (env?.type === "host" && env.hostId) return { kind: "host", hostId: env.hostId };
  if (env?.type === "provider" && env.machine?.type === "existing") return { kind: "host", hostId: env.machine.hostId };
  return null; // Never guess a machine, especially for a newly provisioned host.
}
export function resetLabel(value: string | null, now = Date.now()): string {
  if (!value) return "?";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "?";
  const minutes = Math.max(0, Math.floor((time - now) / 60000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${minutes}m`;
}
