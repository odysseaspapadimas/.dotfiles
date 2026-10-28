import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, sessionIdSchema, type Result } from "./contract.ts";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const pending = new Map<string, Promise<Result>>();
  bb.rpc.register(rpcContract, {
    tasks({ threadId }) {
      const running = pending.get(threadId);
      if (running) return running;
      const request = (async (): Promise<Result> => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.providerId !== "pi" || !thread.environmentId) return { tasks: [], error: null };
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
        if (!environment.hostId) return { tasks: [], error: null };
        // Resolve on every refresh: a provider switch/reset can replace the session.
        const identities = await bb.sdk.threads.events.list({
          threadId, types: ["thread/identity"], order: "desc", limit: "1",
        });
        const identity = identities[0]?.data as { providerThreadId?: unknown } | undefined;
        const session = sessionIdSchema.safeParse(identity?.providerThreadId);
        if (!session.success) return { tasks: [], error: null };
        return host.call("readTasks", { sessionId: session.data }, { hostId: environment.hostId });
      })().catch((): Result => ({ tasks: [], error: "Task updates unavailable. Reconnecting automatically…" }))
        .finally(() => pending.delete(threadId));
      pending.set(threadId, request);
      return request;
    },
  });
}
