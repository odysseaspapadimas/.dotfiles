// Exercise the real launcher, including standalone hosts with no node_modules.
// Only synthetic in-memory history is used; no model requests are sent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const native = fileURLToPath(new URL("../codex-compaction/native-compaction.ts", import.meta.url));
const extension = fileURLToPath(new URL("../codex-compaction/index.ts", import.meta.url));

test("the installed CLI loads native compaction and serializes checkpoints offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-cli-"));
  try {
    const probe = join(root, "probe.ts");
    await writeFile(probe, `
import assert from "node:assert/strict";
import { getModel, normalizeContext, openAIResponsesApi } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import compactionExtension, { registerCodexCompactionExtension } from ${JSON.stringify(extension)};
import { effectiveInputForBranch, modelKey, NATIVE_COMPACTION_KIND } from ${JSON.stringify(native)};

export default async function (pi) {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No network allowed in this probe"); };
  try {
    const model = getModel("openai", "gpt-6.1-sol");
    assert.ok(model);
    const session = SessionManager.inMemory(${JSON.stringify(root)});
    const tool = { name: "grammar_tool", description: "Synthetic grammar probe",
      parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "probe"' } } };
    session.appendMessage({ role: "system", content: "Synthetic rules", toolsAdded: [tool], timestamp: 0 });
    const user = session.appendMessage({ role: "user", content: "Synthetic user turn", timestamp: 1 });
    session.appendMessage({ role: "system", content: "Updated rules", timestamp: 2 });
    const assistant = {
      role: "assistant", provider: model.provider, api: model.api, model: model.id,
      content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_probe", encrypted_content: "opaque-reasoning" }) },
        { type: "toolCall", name: tool.name, id: "call_probe|ctc_probe", arguments: { input: "probe" } }],
      stopReason: "toolUse", timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const appendToolResult = (id) => session.appendMessage({ role: "toolResult", toolName: tool.name,
      toolCallId: id, content: [{ type: "text", text: "Synthetic result" },
        { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }], isError: false, timestamp: 4 });
    session.appendMessage(assistant);
    appendToolResult("call_probe|ctc_probe");
    const input = await effectiveInputForBranch({ branch: session.getBranch(), model, tools: [] });
    assert.ok(input.some((item) => item.role === "developer" && item.content === "Updated rules"));
    assert.ok(input.some((item) => item.type === "additional_tools"));
    assert.ok(input.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque-reasoning"));
    assert.ok(input.some((item) => item.type === "custom_tool_call" && item.input === "probe"));
    assert.ok(input.some((item) => item.type === "custom_tool_call_output" && item.call_id === "call_probe" &&
      Array.isArray(item.output) && item.output.some((part) => part.type === "input_image")));

    const checkpoint = { type: "compaction", encrypted_content: "synthetic-checkpoint" };
    session.appendCompaction("LOCAL", user, 1234, { kind: NATIVE_COMPACTION_KIND, version: 1,
      modelKey: modelKey(model), replacementHistory: [checkpoint] }, true);
    session.appendMessage({ ...assistant, content: [{ type: "toolCall", name: tool.name,
      id: "call_after|ctc_after", arguments: { input: "probe" } }] });
    appendToolResult("call_after|ctc_after");
    const replay = await effectiveInputForBranch({ branch: session.getBranch(), model, tools: [] });
    assert.deepEqual(replay[0], checkpoint);
    assert.ok(replay.some((item) => item.type === "additional_tools" && item.tools.some((entry) => entry.name === tool.name && entry.type === "custom")));
    assert.ok(replay.some((item) => item.type === "custom_tool_call_output" && item.call_id === "call_after"));
    assert.equal(JSON.stringify(replay).includes("Synthetic user turn"), false);

    // Verify the new live replay path in the actual launcher too, including
    // standalone hosts: serialize around the placeholder, not a rebuilt input.
    const handlers = new Map();
    registerCodexCompactionExtension({
      on: (name, handler) => { handlers.set(name, handler); return () => {}; },
      registerEntryRenderer() {}, getAllTools: () => [], getActiveTools: () => [],
    });
    const ctx = { model, sessionManager: session, mode: "print", hasUI: false,
      getSystemPrompt: () => "Synthetic rules", abort: () => { throw new Error("Unexpected replay abort"); } };
    const projected = session.buildSessionProjection().messages;
    const context = handlers.get("context_with_system")({ messages: projected }, ctx);
    let serialized;
    await openAIResponsesApi().stream(model, normalizeContext({ messages: convertToLlm(context.messages) }), {
      apiKey: "serialization-only", maxRetries: 0,
      fetch: async () => { throw new Error("No network allowed"); },
      onPayload: (payload) => { serialized = payload; throw new Error("Serialization complete"); },
    }).result();
    assert.ok(serialized);
    const original = structuredClone(serialized);
    const patched = await handlers.get("before_provider_request")({ payload: serialized }, ctx);
    assert.deepEqual(serialized, original);
    assert.deepEqual(patched.input.filter((item) => item.type === "additional_tools"),
      original.input.filter((item) => item.type === "additional_tools"));
    assert.deepEqual(patched.input.filter((item) => item.type === "compaction"), [checkpoint]);
    assert.equal(patched.input[0].type, "compaction", "public checkpoint must precede Pi's callable declarations");
    assert.ok(patched.input.findIndex((item) => item.type === "additional_tools") > 0);
    assert.ok(patched.input.some((item) => item.type === "custom_tool_call_output" && item.call_id === "call_after"));
    assert.equal(JSON.stringify(patched).includes("OpenAI Codex native compaction history"), false);
    assert.equal(JSON.stringify(patched).includes("Synthetic user turn"), false);
    assert.equal(requests, 0);
    compactionExtension(pi);
    pi.registerCommand("compaction-compatibility-passed", { description: "Offline regression probe", handler: async () => {} });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
`);
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    for (const key of Object.keys(env)) {
      if (key.startsWith("HERDR_") || key.startsWith("PI_HERDR_SIDE")) delete env[key];
    }
    const result = spawnSync(process.env.PI_TEST_CLI ?? "pi", [
      "--offline", "--no-session", "--no-mcp", "--no-approve", "-ne", "-ns", "-np", "-nc",
      "--no-themes", "-e", probe, "--mode", "rpc",
    ], { cwd: root, env, encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ id: "probe", type: "get_commands" }) + "\n" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const response = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .find((record) => record.id === "probe");
    assert.equal(response?.success, true, result.stdout);
    assert.ok(response.data.commands.some((command) => command.name === "compaction-compatibility-passed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
