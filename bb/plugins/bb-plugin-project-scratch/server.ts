import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contract.ts";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  async function location(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no workspace yet.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== "ready" || !environment.path || !environment.hostId) throw new Error("The workspace is not ready.");
    return { cwd: environment.path, hostId: environment.hostId };
  }
  bb.rpc.register(rpcContract, {
    async load({ threadId }) {
      const { cwd, hostId } = await location(threadId);
      return host.call("load", { cwd }, { hostId });
    },
    async save({ threadId, ...input }) {
      const { cwd, hostId } = await location(threadId);
      return host.call("save", { cwd, ...input }, { hostId });
    },
    async preview({ threadId, text }) {
      const { cwd, hostId } = await location(threadId);
      return host.call("preview", { cwd, text }, { hostId });
    },
    async promote({ threadId, token, confirmed }) {
      const { cwd, hostId } = await location(threadId);
      return host.call("promote", { cwd, token, confirmed }, { hostId });
    },
  });
  // No agent tools or automatic context injection.
}
