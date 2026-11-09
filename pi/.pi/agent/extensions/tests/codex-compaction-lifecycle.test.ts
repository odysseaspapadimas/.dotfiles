// Real SDK prompt/compact/resume lifecycle, but every response is synthetic SSE.
// No stored user session, credentials, provider network, or executable shell call.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import compactionExtension from "../codex-compaction/index.ts";

function response(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

function toolNames(input: any[]): string[] {
  return input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools.map((tool: any) => tool.name));
}

test("public SDK preserves tools through repeated maintenance and fresh-runtime resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-lifecycle-"));
  const previousFetch = globalThis.fetch;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  initTheme("dark", false);
  const requests: any[] = [];
  let checkpointNumber = 0;
  globalThis.fetch = async (_url, options) => {
    assert.ok(options?.body, "only synthetic Responses calls are allowed");
    const body = JSON.parse(String(options.body));
    requests.push(structuredClone(body));
    const maintenance = Array.isArray(body.context_management);
    const item = maintenance
      ? { type: "compaction", encrypted_content: `synthetic-${++checkpointNumber}` }
      : { type: "message", role: "assistant", id: `msg_${requests.length}`, content: [{ type: "output_text", text: "Synthetic complete", annotations: [] }] };
    const events = maintenance ? [] : [{ type: "response.output_item.added", output_index: 0, item }];
    return response([...events, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]);
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const model = getModel("openai", "gpt-6.1-sol")!;
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false });
    await runtime.setRuntimeApiKey("openai", "synthetic-key");
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 0 }, retry: { enabled: false } });
    let manager = SessionManager.inMemory(root);
    let extensionApi: ExtensionAPI;
    let lateRegistered = false;
    const lateTool = { name: "late_probe", label: "Late probe", description: "Synthetic dynamically registered tool",
      parameters: Type.Object({ value: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "CONSTANT" }], details: undefined }) };
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Synthetic native compaction test rules.",
      extensionFactories: [compactionExtension, (pi) => {
        extensionApi = pi;
        if (lateRegistered) pi.registerTool(lateTool);
        pi.registerTool({ name: "grammar_probe", label: "Grammar", description: "Synthetic grammar probe",
          parameters: Type.Object({ input: Type.String() }),
          constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "probe"' } },
          execute: async () => { throw new Error("This test never executes a tool"); } });
      }] });
    const errors: unknown[] = [];
    const open = async (reason: "startup" | "resume" | "reload") => {
      await loader.reload();
      const created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), model, modelRuntime: runtime,
        settingsManager: settings, sessionManager: manager, resourceLoader: loader,
        sessionStartEvent: { type: "session_start", reason } });
      session = created.session;
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    };
    await open("startup");
    await session!.prompt("Synthetic task before compaction.");
    const initial = requests.at(-1);
    assert.ok(toolNames(initial.input).includes("grammar_probe"));
    await session!.compact();
    await session!.prompt("Synthetic task after first checkpoint.");
    const first = requests.at(-1);
    assert.ok(first.input.some((item: any) => item.type === "compaction"));
    assert.ok(toolNames(first.input).includes("grammar_probe"));
    // A bounded fictional-provider A/B proved that the public checkpoint resets
    // callable tools: merely retaining additional_tools BEFORE it is not enough.
    assert.deepEqual(first.input.map((item: any) => item.type ?? item.role),
      ["compaction", "additional_tools", "developer", "user"]);

    // Match a prompt-only system patch after a checkpoint: it has no tool delta
    // and cannot substitute for replaying the full schemas after the checkpoint.
    manager.appendMessage({ role: "system", content: "Updated fictional rules", timestamp: Date.now() });
    lateRegistered = true;
    extensionApi!.registerTool(lateTool);
    await session!.prompt("Synthetic task with a late registered tool and prompt patch.");
    const updated = requests.at(-1);
    assert.equal(updated.input[0].type, "compaction");
    assert.ok(toolNames(updated.input).includes("late_probe"));
    assert.ok(JSON.stringify(updated.input).includes("Updated fictional rules"));
    extensionApi!.setActiveTools(extensionApi!.getActiveTools().filter((name) => name !== "write"));
    await session!.prompt("Synthetic task with write removed.");
    await session!.compact();
    await session!.prompt("Synthetic task after second checkpoint.");
    assert.equal(checkpointNumber, 2);
    assert.ok(toolNames(requests.at(-1).input).includes("late_probe"));
    assert.equal(requests.at(-1).input[0].type, "compaction");
    assert.ok(toolNames(requests.at(-1).input).includes("grammar_probe"));
    assert.equal(toolNames(requests.at(-1).input).includes("write"), false);
    await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session!.dispose();
    session = undefined;
    // JSON-roundtrip the saved entries, like a real persisted resume, not just
    // a new extension instance sharing the previous manager's object state.
    const persisted = JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()]));
    manager = SessionManager.inMemory(root, undefined, persisted);
    await open("resume");
    await session!.prompt("Synthetic task in a fresh resumed runtime.");
    assert.equal(requests.at(-1).input[0].type, "compaction");
    assert.ok(toolNames(requests.at(-1).input).includes("grammar_probe"));
    await session!.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    session!.dispose();
    session = undefined;
    await open("reload");
    await session!.prompt("Synthetic task after reload.");
    assert.equal(requests.at(-1).input[0].type, "compaction");
    assert.ok(toolNames(requests.at(-1).input).includes("grammar_probe"));

    // Older persisted native checkpoints used the same details format but may
    // not contain Pi's newer systemMessage snapshot. Fresh runtime bootstrap
    // must still declare its actual current tools after the opaque checkpoint.
    await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session!.dispose();
    session = undefined;
    const legacy = JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()]));
    for (const entry of legacy) if (entry.type === "compaction") delete entry.systemMessage;
    manager = SessionManager.inMemory(root, undefined, legacy);
    await open("resume");
    await session!.prompt("Synthetic task resumed from a legacy native checkpoint.");
    assert.equal(requests.at(-1).input[0].type, "compaction");
    assert.ok(toolNames(requests.at(-1).input).includes("grammar_probe"));
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  }
});
