import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
test("resolves actual thread host and latest provider identity, not browser paths", async () => {
  const callHost = vi.fn().mockResolvedValue({ tasks: [], error: null });
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-todos", experimental_hostEntry: true,
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "t", providerId: "pi", environmentId: "e" }),
        events: { list: async () => [{ data: { providerThreadId: "pi_session" } }] as never },
      },
      environments: { get: async () => ({ hostId: "machine" }) as never },
    },
    experimental_callHostRpc: callHost,
  });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("tasks", { threadId: "t" })).toEqual({ tasks: [], error: null });
    expect(callHost.mock.calls[0]![0]).toMatchObject({ method: "readTasks", input: { sessionId: "pi_session" }, hostId: "machine" });
  } finally { await harness.lifecycle.dispose(); }
});
