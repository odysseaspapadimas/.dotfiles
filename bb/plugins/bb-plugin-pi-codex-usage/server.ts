import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { inventorySchema, observationSchema, rpcContract, type Target, type Result } from "./contract.ts";

export default function plugin(bb: BbPluginApi) {
  async function hostIdFor(target: Target): Promise<string | null> {
    if (target.kind === "host") return target.hostId;
    let environmentId: string;
    if (target.kind === "thread") {
      const thread = await bb.sdk.threads.get({ threadId: target.threadId });
      if (!thread.environmentId) return null;
      environmentId = thread.environmentId;
    } else environmentId = target.environmentId;
    return (await bb.sdk.environments.get({ environmentId })).hostId;
  }
  // Coalesce split composers and bound automatic polling to one request/minute/machine.
  const cache = new Map<string, { at: number; result: Result }>();
  const pending = new Map<string, Promise<Result>>();
  bb.rpc.register(rpcContract, {
    async usage({ target, refresh }): Promise<Result> {
      const hostId = await hostIdFor(target);
      if (!hostId) return { hostName: null, observedAt: null, usage: { status: "error", message: "Select a ready machine to view Codex usage." } };
      const cached = cache.get(hostId);
      if (!refresh && cached && Date.now() - cached.at < 60000) return cached.result;
      const running = pending.get(hostId);
      if (running) return running;
      const request = (async (): Promise<Result> => {
        try {
          const inventory = await bb.sdk.plugins.callRpc({
            pluginId: "provider-codex", method: "provider-usage.v1.listResources",
            input: {}, outputSchema: inventorySchema,
          });
          const resource = inventory.resources.find(item =>
            item.providerId === "codex" && item.scope.kind === "host" && item.scope.hostId === hostId);
          if (!resource || resource.scope.kind !== "host")
            return { hostName: null, observedAt: null, usage: { status: "error", message: "No Codex usage source on this machine. Enable the Codex provider and sign in with codex." } };
          const observation = await bb.sdk.plugins.callRpc({
            pluginId: "provider-codex", method: "provider-usage.v1.getResource",
            input: { resourceId: resource.id, refresh }, outputSchema: observationSchema,
          });
          return { hostName: resource.scope.hostName, ...observation };
        } catch {
          // Don't forward arbitrary RPC errors or credential-related details into the browser.
          return { hostName: null, observedAt: null, usage: { status: "error", message: "Codex usage unavailable. Check the Codex provider and machine connection, then retry." } };
        }
      })().then(result => {
        cache.set(hostId, { at: Date.now(), result });
        if (cache.size > 100) cache.delete(cache.keys().next().value!);
        return result;
      }).finally(() => pending.delete(hostId));
      pending.set(hostId, request);
      return request;
    },
  });
}
