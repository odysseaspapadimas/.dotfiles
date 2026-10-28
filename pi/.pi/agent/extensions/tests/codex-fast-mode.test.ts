import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fastMode, { FAST_MODE_MODEL_IDS, FAST_MODE_STATUS_KEY, supportsFastMode } from "../codex-fast-mode/index.ts";

const model = (id = "gpt-6.1-sol", provider = "openai-codex",
  api = provider === "openai" ? "openai-responses" : "openai-codex-responses") => ({ id, provider, api });

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let command: any;
  const branch: any[] = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: { message: string; level: string }[] = [];
  const ctx = { model: model(), sessionManager: { getBranch: () => branch }, ui: {
    theme: { fg: (_color: string, value: string) => value },
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    notify: (message: string, level: string) => notifications.push({ message, level }),
  } };
  fastMode({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerProvider: () => { throw new Error("Fast Mode must preserve Pi's native provider"); },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, branch, statuses, notifications, emit, command };
}

test("Fast Mode supports the model allowlist on OpenAI and Codex, not Spark or unrelated providers", () => {
  for (const id of FAST_MODE_MODEL_IDS) {
    assert.equal(supportsFastMode(model(id)), true, id);
    assert.equal(supportsFastMode(model(id, "openai")), true, id);
    assert.equal(supportsFastMode(model(id, "openai", "openai-completions")), true, id);
  }
  assert.equal(supportsFastMode(model("gpt-6.1-sol", "other", "openai-responses")), false);
  assert.equal(supportsFastMode(model("gpt-6.1-sol", "openai", "anthropic-messages")), false);
  assert.equal(supportsFastMode(model("gpt-6.1-sol", "openai-codex", "openai-responses")), false);
  for (const provider of ["openai", "openai-codex"]) {
    assert.equal(supportsFastMode(model("gpt-5.3-codex-spark", provider)), false);
    assert.equal(supportsFastMode(model("gpt-6-mini", provider)), false);
  }
  assert.equal(supportsFastMode(undefined), false);
});

for (const selectedModel of [model(), model("gpt-6.1-sol", "openai"), model("gpt-6.1-sol", "openai", "openai-completions")]) {
  test(`priority is added only when enabled for ${selectedModel.provider}/${selectedModel.api}; the native payload stays intact`, async () => {
    const { ctx, command, emit, statuses, notifications } = setup();
    ctx.model = selectedModel;
    const payload = { model: selectedModel.id, input: [{ role: "user", content: "hello" }], reasoning: { effort: "max" }, tools: [], store: false };
    assert.equal(emit("before_provider_request", { payload }), undefined);
    await command.handler("on", ctx);
    const modified = emit("before_provider_request", { payload });
    assert.deepEqual(modified, { ...payload, service_tier: "priority" });
    assert.equal(modified.input, payload.input);
    assert.equal(modified.reasoning, payload.reasoning);
    assert.equal("service_tier" in payload, false);
    assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast");
    assert.deepEqual(notifications.at(-1), { message: "Fast Mode enabled.", level: "warning" });
    ctx.model = model("gpt-6-mini", selectedModel.provider, selectedModel.api);
    emit("model_select");
    assert.equal(emit("before_provider_request", { payload }), undefined);
    assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast (inactive)");
    ctx.model = selectedModel;
    await command.handler("off", ctx);
    assert.equal(emit("before_provider_request", { payload }), undefined);
    assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined);
  });
}

test("the footer marker follows toggles, restored branches, and model compatibility", async () => {
  const { ctx, branch, command, emit, statuses } = setup();
  emit("session_start");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined);
  await command.handler("", ctx);
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast");
  ctx.model = model("gpt-6-mini");
  emit("model_select");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast (inactive)");
  ctx.model = model();
  emit("model_select");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast");
  emit("session_shutdown");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined);
  emit("session_start");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast", "restore enabled state on resume/reload");
  branch.length = 0;
  emit("session_tree");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined, "do not leak state from another branch");
  ctx.model = model("gpt-6.1-sol", "openai");
  await command.handler("on", ctx);
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast");
  emit("session_shutdown");
  emit("session_start");
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), "fast");
  await command.handler("", ctx);
  assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined);
});

test("the default footer sorts Fast Mode ahead of other extension statuses", async () => {
  const { ctx, command, statuses } = setup();
  statuses.set("context-usage", "a very long context status");
  statuses.set("pi-sessions", "a very long session status");
  await command.handler("on", ctx);
  assert.equal([...statuses].sort(([a], [b]) => a.localeCompare(b))[0][1], "fast");
});

test("the WebSocket originator patch is scoped to Codex and disabled on shutdown", async () => {
  const native = globalThis.WebSocket;
  const key = Symbol.for("codex-fast-mode.websocket-patch");
  const globals = globalThis as any;
  const oldState = globals[key];
  const calls: any[][] = [];
  delete globals[key];
  globals.WebSocket = class { constructor(...args: any[]) { calls.push(args); } };
  try {
    const { ctx, command, emit } = setup();
    await command.handler("on", ctx);
    new globals.WebSocket("wss://chatgpt.com/backend-api/codex/responses", { headers: { originator: "pi", other: "kept" } });
    assert.equal(calls[0][1].headers.get("originator"), "codex_cli_rs");
    assert.equal(calls[0][1].headers.get("other"), "kept");
    const unrelated = { headers: { originator: "unrelated" } };
    new globals.WebSocket("wss://example.test/socket", unrelated);
    assert.equal(calls[1][1], unrelated);
    ctx.model = model("gpt-6.1-sol", "openai");
    emit("model_select");
    const apiHeaders = { headers: { originator: "pi" } };
    new globals.WebSocket("wss://chatgpt.com/backend-api/codex/responses", apiHeaders);
    assert.equal(calls[2][1], apiHeaders, "OpenAI API Fast Mode must not enable the Codex header patch");
    ctx.model = model();
    emit("model_select");
    new globals.WebSocket("wss://chatgpt.com/backend-api/codex/responses", { headers: { originator: "pi" } });
    assert.equal(calls[3][1].headers.get("originator"), "codex_cli_rs");
    emit("session_shutdown");
    const standard = { headers: { originator: "pi" } };
    new globals.WebSocket("wss://chatgpt.com/backend-api/codex/responses", standard);
    assert.equal(calls[4][1], standard);
  } finally {
    globalThis.WebSocket = native;
    if (oldState) globals[key] = oldState;
    else delete globals[key];
  }
});
