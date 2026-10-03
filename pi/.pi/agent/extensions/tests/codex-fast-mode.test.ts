import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fastMode, { FAST_MODE_MODEL_IDS, supportsFastMode } from "../codex-fast-mode/index.ts";

const model = (id = "gpt-6.1-sol", provider = "openai-codex") => ({ id, provider, api: "openai-codex-responses" });

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let command: any;
  const branch: any[] = [];
  const statuses = new Map<string, string | undefined>();
  const ctx = { model: model(), sessionManager: { getBranch: () => branch }, ui: {
    theme: { fg: (_color: string, value: string) => value },
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value), notify() {},
  } };
  fastMode({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerProvider: () => { throw new Error("Fast Mode must preserve Pi's native provider"); },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, branch, statuses, emit, command };
}

test("Fast Mode recognizes the current GPT-6 catalog without enabling API-key or Spark models", () => {
  for (const id of FAST_MODE_MODEL_IDS) assert.equal(supportsFastMode(model(id)), true, id);
  assert.equal(supportsFastMode(model("gpt-6.1-sol", "openai")), false);
  assert.equal(supportsFastMode(model("gpt-5.3-codex-spark")), false);
  assert.equal(supportsFastMode(model("gpt-6-mini")), false);
  assert.equal(supportsFastMode(undefined), false);
});

test("priority is added only to enabled Codex requests; the native payload stays intact", async () => {
  const { ctx, command, emit, statuses } = setup();
  const payload = { model: "gpt-6.1-sol", input: [{ role: "user", content: "hello" }], reasoning: { effort: "max" }, tools: [], store: false };
  assert.equal(emit("before_provider_request", { payload }), undefined);
  await command.handler("on", ctx);
  const modified = emit("before_provider_request", { payload });
  assert.deepEqual(modified, { ...payload, service_tier: "priority" });
  assert.equal(modified.input, payload.input);
  assert.equal("service_tier" in payload, false);
  assert.equal(statuses.get("zz-codex-fast-mode"), "fast");
  ctx.model = model("gpt-6.1-sol", "openai");
  emit("model_select");
  assert.equal(emit("before_provider_request", { payload }), undefined);
  assert.equal(statuses.get("zz-codex-fast-mode"), undefined);
  ctx.model = model();
  await command.handler("off", ctx);
  assert.equal(emit("before_provider_request", { payload }), undefined);
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
    emit("session_shutdown");
    const standard = { headers: { originator: "pi" } };
    new globals.WebSocket("wss://chatgpt.com/backend-api/codex/responses", standard);
    assert.equal(calls[2][1], standard);
  } finally {
    globalThis.WebSocket = native;
    if (oldState) globals[key] = oldState;
    else delete globals[key];
  }
});
