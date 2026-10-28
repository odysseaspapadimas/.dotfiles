// @vitest-environment node
import { expect, test } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("server resolves the owning host and workspace instead of accepting client paths", async () => {
  const host = createFakePluginHost({
    pluginId: "project-scratch", experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => makeThreadResponse({ environmentId: "env-test" }) },
      environments: { get: async () => ({ path: "/remote/project", hostId: "remote-host", status: "ready" }) as never },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      expect(method).toBe("load"); expect(input).toEqual({ cwd: "/remote/project" }); expect(hostId).toBe("remote-host");
      return { root: "/remote/project", text: "", revision: "a".repeat(64), imported: false };
    },
  });
  try {
    await plugin(host.bb);
    await host.harness.behavior.callRpc("load", { threadId: "t" });
    await expect(host.harness.behavior.callRpc("load", { threadId: "t", cwd: "/other" })).rejects.toThrow();
    expect(host.harness.registrations.agentTools).toHaveLength(0);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("plugin uses public SDK contracts only", async () => {
  const result = await experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^@tiptap\/(react|starter-kit|extension-task-list|extension-task-item|markdown)$/, /^react(?:-dom)?$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^vitest\/config$/, /^@\/components\/ui\/button$/] });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
