// @vitest-environment node
import { expect, test, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Target } from "./contract.ts";
import plugin from "./server.ts";

// Narrow adapter isolates public RPC forwarding without a database or credentials.
function setup(resources = [{ id: "right", providerId: "codex", label: "Codex", scope: { kind: "host", hostId: "h", hostName: "machine" } }]) {
  let handler: (input: { target: Target; refresh: boolean }) => Promise<unknown>;
  const callRpc = vi.fn().mockImplementation(async ({ method, input, outputSchema }) => outputSchema.parse(
    method.endsWith("listResources") ? { resources } : { observedAt: 123, usage: { status: "ok", accountEmail: null, planLabel: "Pro", windows: [] } },
  ));
  const thread = vi.fn().mockResolvedValue({ environmentId: "e" });
  const environment = vi.fn().mockResolvedValue({ hostId: "h" });
  plugin({
    sdk: { threads: { get: thread }, environments: { get: environment }, plugins: { callRpc } },
    rpc: { register: (_contract: unknown, handlers: { usage: typeof handler }) => { handler = handlers.usage; } },
  } as unknown as BbPluginApi);
  const run = async (target: Target = { kind: "thread", threadId: "t" }, refresh = false) => {
    const input = rpcContract.usage.input.parse({ target, refresh });
    return rpcContract.usage.output.parse(await handler!(input));
  };
  return { run, callRpc, thread, environment };
}
test("resolves the thread machine and uses only its Codex source", async () => {
  const { run, callRpc, thread, environment } = setup([
    { id: "wrong", providerId: "codex", label: "Codex", scope: { kind: "host", hostId: "other", hostName: "other" } },
    { id: "right", providerId: "codex", label: "Codex", scope: { kind: "host", hostId: "h", hostName: "machine" } },
  ]);
  expect((await run()).hostName).toBe("machine");
  expect(thread).toHaveBeenCalledWith({ threadId: "t" });
  expect(environment).toHaveBeenCalledWith({ environmentId: "e" });
  expect(callRpc.mock.calls[1]![0].input).toEqual({ resourceId: "right", refresh: false });
  await run();
  expect(callRpc).toHaveBeenCalledTimes(2);
  await run(undefined, true);
  expect(callRpc).toHaveBeenCalledTimes(4);
  expect(callRpc.mock.calls[3]![0].input.refresh).toBe(true);
});
test("does not fall back to another machine", async () => {
  const { run, callRpc } = setup();
  const result = await run({ kind: "host", hostId: "other" });
  expect(result.usage.status).toBe("error");
  expect(callRpc).toHaveBeenCalledTimes(1);
});
test("bounds concurrent requests", async () => {
  const { run, callRpc } = setup();
  await Promise.all([run(), run(), run()]);
  expect(callRpc).toHaveBeenCalledTimes(2);
});
test("handles missing plugin and suppresses raw errors", async () => {
  const { run, callRpc } = setup();
  callRpc.mockRejectedValueOnce(new Error("sensitive raw diagnostic"));
  const result = await run();
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(result.usage.status).toBe("error");
});
test("forwards environment selections", async () => {
  const { run, thread, environment } = setup();
  await run({ kind: "environment", environmentId: "selected" });
  expect(thread).not.toHaveBeenCalled();
  expect(environment).toHaveBeenCalledWith({ environmentId: "selected" });
});
