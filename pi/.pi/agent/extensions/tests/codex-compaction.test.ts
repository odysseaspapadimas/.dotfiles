import assert from "node:assert/strict";
import { test } from "node:test";
import { getModel, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerCodexCompactionExtension } from "../codex-compaction/index.ts";
import {
  buildPublicCompactionRequestBody, buildPublicHeaders, buildReplacementHistory,
  callRemoteCompaction, effectiveInputForBranch, isNativeCompactionModel,
  NATIVE_COMPACTION_KIND, parseNativeCompactionDetails, modelKey,
  resolvePublicResponsesUrl, type NativeCompactionDetails, type ResponseItem,
} from "../codex-compaction/native-compaction.ts";

const publicModel = getModel("openai", "gpt-6.1-sol")!;
const codexModel = getModel("openai-codex", "gpt-6.1-sol")!;
const checkpoint = (value = "encrypted-checkpoint"): ResponseItem => ({ type: "compaction", id: `cmp_${value}`, encrypted_content: value });
const acknowledgement: ResponseItem = { type: "message", role: "assistant", id: "msg_ack", content: [{ type: "output_text", text: "OK", annotations: [] }] };
const usage = { input_tokens: 1400, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 }, output_tokens: 200, total_tokens: 1600 };

function sse(items: ResponseItem[], options: { completed?: boolean; finalOutput?: unknown } = {}): Response {
  const events: unknown[] = items.map((item) => ({ type: "response.output_item.done", item }));
  if (options.completed !== false) events.push({ type: "response.completed", response: { usage, output: options.finalOutput ?? items } });
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  // Exercise UTF-8/SSE boundaries rather than relying on one complete frame.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

function details(model: Model<any> = publicModel, items = [checkpoint(), acknowledgement]): NativeCompactionDetails {
  return { kind: NATIVE_COMPACTION_KIND, version: 1, modelKey: modelKey(model), replacementHistory: items };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant", provider: publicModel.provider, api: publicModel.api, model: publicModel.id,
    content, stopReason: "toolUse", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function harness(model: Model<any> = publicModel) {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "user", content: "Continue the Cedar refactor; preserve tests.", timestamp: 1 });
  const handlers = new Map<string, (...args: any[]) => any>();
  const notifications: string[] = [];
  let aborted = false;
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => {}; },
    registerEntryRenderer() {}, getAllTools: () => [], getActiveTools: () => [],
    appendEntry: (kind: string, value: unknown) => session.appendCustomEntry(kind, value),
  };
  const ctx = {
    model, sessionManager: session, mode: "print", hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
    abort: () => { aborted = true; }, getSystemPrompt: () => "Current project rules",
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "opaque-subscription-token", headers: { "x-test": "retained", "x-removed": null } }) },
  } as unknown as ExtensionContext;
  registerCodexCompactionExtension(pi as unknown as ExtensionAPI, "1.1.0");
  const compactEvent = () => ({
    branchEntries: session.getBranch(), reason: "manual", willRetry: false,
    preparation: { firstKeptEntryId: session.getBranch()[0]!.id, tokensBefore: 450001 },
    signal: new AbortController().signal,
  });
  return { session, handlers, ctx, notifications, compactEvent, aborted: () => aborted };
}

test("native compaction supports only the two OpenAI Responses connections", () => {
  assert.equal(isNativeCompactionModel(publicModel), true);
  assert.equal(isNativeCompactionModel(codexModel), true);
  assert.equal(isNativeCompactionModel({ ...publicModel, provider: "azure" }), false);
  assert.equal(isNativeCompactionModel({ ...publicModel, api: "openai-completions" }), false);
  assert.equal(isNativeCompactionModel(undefined), false);
});

test("public maintenance uses inline compaction, not the unauthorized standalone endpoint", () => {
  const input = [{ role: "user", content: "Cedar" }];
  const body = buildPublicCompactionRequestBody({ model: publicModel, input, instructions: "Project rules",
    basePayload: { previous_response_id: "old", service_tier: "priority", tools: [{ type: "function", name: "test" }] } });
  assert.equal(resolvePublicResponsesUrl(), "https://api.openai.com/v1/responses");
  assert.equal(resolvePublicResponsesUrl("https://api.openai.com/v1/responses/"), "https://api.openai.com/v1/responses");
  assert.deepEqual(body.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, "none");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.instructions, "Project rules");
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.service_tier, undefined);
  assert.deepEqual(body.input, input);
  assert.notEqual(body.input, input);
  const headers = buildPublicHeaders({ apiKey: "opaque-token", headers: { "x-test": "ok", "x-removed": null } });
  assert.equal(headers.get("authorization"), "Bearer opaque-token");
  assert.equal(headers.get("x-test"), "ok");
  assert.equal(headers.has("x-removed"), false);
  assert.equal(headers.has("chatgpt-account-id"), false);
  assert.equal(headers.has("x-codex-beta-features"), false);
});

test("public SSE keeps the pre-generation checkpoint, discards unused continuation, and records usage", async () => {
  const tail = { type: "reasoning", id: "rs_after", encrypted_content: "encrypted-reasoning" };
  const result = await callRemoteCompaction({ url: "https://example.invalid/responses", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => sse([checkpoint("earlier"), acknowledgement, checkpoint("latest"), tail, acknowledgement]) });
  assert.deepEqual(result.replacementHistory, [checkpoint("earlier")]);
  assert.deepEqual(result.compactionItem, checkpoint("earlier"));
  assert.equal(result.usage?.input, 1100);
  assert.equal(result.usage?.cacheRead, 100);
  assert.equal(result.usage?.cacheWrite, 200);
  assert.equal(result.usage?.output, 200);
  assert.equal(result.usage?.totalTokens, 1600);
});

test("public checkpoint stream survives omission from the terminal response output", async () => {
  const result = await callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => sse([checkpoint(), acknowledgement], { finalOutput: [acknowledgement] }) });
  assert.deepEqual(result.replacementHistory, [checkpoint()]);
});

test("a truncated unused continuation cannot invalidate a completed pre-generation checkpoint", async () => {
  const event = { type: "response.incomplete", response: { usage, output: [], incomplete_details: { reason: "max_output_tokens" } } };
  const result = await callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: checkpoint() })}\n\ndata: ${JSON.stringify(event)}\n\n`) });
  assert.deepEqual(result.replacementHistory, [checkpoint()]);
  assert.equal(result.usage?.totalTokens, 1600);
});

test("a checkpoint emitted only after generation is not mistaken for an original-window checkpoint", async () => {
  await assert.rejects(callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => sse([acknowledgement, checkpoint()]) }), /no pre-generation compaction checkpoint/);
});

test("checkpoint parsing remains backwards compatible without treating public output as Codex output", () => {
  assert.ok(parseNativeCompactionDetails(details()));
  assert.ok(parseNativeCompactionDetails(details(codexModel, [{ role: "user", content: "Cedar" }, checkpoint()])));
  assert.equal(parseNativeCompactionDetails(details(codexModel)), undefined);
  assert.equal(parseNativeCompactionDetails(details(publicModel, [checkpoint("")])), undefined);
  assert.equal(parseNativeCompactionDetails(details(publicModel, [checkpoint(), checkpoint("second")])), undefined);
  assert.equal(parseNativeCompactionDetails({ ...details(), version: 999 }), undefined);
});

test("public conversion preserves prompt/tool deltas, grammar calls, reasoning and tool pairing", () => {
  const session = SessionManager.inMemory("/tmp");
  const grammarTool = { name: "grammar_tool", description: "Grammar probe", parameters: Type.Object({ input: Type.String() }),
    constrainedSampling: { type: "grammar" as const, variants: { openai_lark: 'start: "probe"' } } };
  session.appendMessage({ role: "system", content: "Original rules", toolsAdded: [grammarTool], timestamp: 0 });
  session.appendMessage({ role: "user", content: "Investigate Cedar", timestamp: 1 });
  session.appendMessage({ role: "system", content: "Updated rules", toolsAdded: [{ name: "extra", description: "Extra tool", parameters: Type.Object({}) }], timestamp: 2 });
  session.appendMessage(assistant([
    { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_probe", encrypted_content: "opaque-reasoning" }) },
    { type: "toolCall", name: "grammar_tool", id: "call_probe|ctc_probe", arguments: { input: "probe" } },
  ]));
  session.appendMessage({ role: "toolResult", toolCallId: "call_probe|ctc_probe", toolName: "grammar_tool", content: [{ type: "text", text: "Passed" }], isError: false, timestamp: 3 });
  const input = effectiveInputForBranch({ branch: session.getBranch(), model: publicModel, tools: [] });
  assert.ok(input.some((item) => item.role === "developer" && item.content === "Updated rules"));
  assert.ok(input.some((item) => item.type === "additional_tools"));
  assert.ok(input.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque-reasoning"));
  assert.ok(input.some((item) => item.type === "custom_tool_call" && item.input === "probe"));
  assert.ok(input.some((item) => item.type === "custom_tool_call_output" && item.call_id === "call_probe"));
});

test("public checkpoint replay restores callable schemas and grammar metadata, not just tool names", async () => {
  const h = harness();
  const read = { name: "read", description: "Read a synthetic fixture", parameters: Type.Object({ path: Type.String() }) };
  const codemode = { name: "codemode", description: "Synthetic grammar tool", parameters: Type.Object({ input: Type.String() }),
    constrainedSampling: { type: "grammar" as const, variants: { openai_lark: 'start: "probe"' } } };
  h.session.appendMessage({ role: "system", content: "Use read and codemode.", toolsAdded: [read, codemode], timestamp: 1 });
  const old = h.session.appendMessage({ role: "user", content: "Inspect the fixture", timestamp: 2 });
  h.session.appendCompaction("LOCAL", old, 10000, details(publicModel, [checkpoint()]), true);
  h.session.appendMessage(assistant([{ type: "toolCall", name: "codemode", id: "call_after|ctc_after", arguments: { input: "probe" } }]));
  h.session.appendMessage({ role: "toolResult", toolCallId: "call_after|ctc_after", toolName: "codemode", content: [{ type: "text", text: "Passed" }], isError: false, timestamp: 3 });

  // Modern Responses requests have no top-level tools: Pi declares them inline.
  // Replacing input must not drop those declarations or the grammar call metadata.
  const payload = await h.handlers.get("before_provider_request")!({ payload: {
    model: publicModel.id, input: [{ type: "additional_tools", role: "developer", tools: [{ name: "read" }, { name: "codemode" }] }],
  } }, h.ctx);
  assert.equal(payload.tools, undefined);
  assert.deepEqual(payload.input[0], checkpoint());
  const declarations = payload.input.filter((item: ResponseItem) => item.type === "additional_tools").flatMap((item: ResponseItem) => item.tools);
  assert.deepEqual(declarations.map((tool: any) => tool.name), ["read", "codemode"]);
  assert.equal(declarations[0].parameters.properties.path.type, "string");
  assert.equal(declarations[1].type, "custom");
  assert.equal(declarations[1].format.type, "grammar");
  assert.ok(payload.input.some((item: ResponseItem) => item.type === "custom_tool_call" && item.input === "probe"));
  assert.ok(payload.input.some((item: ResponseItem) => item.type === "custom_tool_call_output" && item.call_id === "call_after"));
});

test("replay seeds checkpoint-time tools before later additions, removals and redefinitions", () => {
  const tool = (name: string, description = name) => ({ name, description, parameters: Type.Object({}) });
  for (const inherited of [false, true]) {
    const session = SessionManager.inMemory("/tmp");
    session.appendMessage({ role: "system", content: "Rules", toolsAdded: [tool("read", "old"), tool("removed")], timestamp: 0 });
    const user = session.appendMessage({ role: "user", content: "Inspect Cedar", timestamp: 1 });
    session.appendMessage({ role: "system", content: "", toolsRemoved: [{ name: "removed" }, { name: "read" }], toolsAdded: [tool("read", "checkpoint")], timestamp: 2 });
    if (inherited) session.appendCustomEntry(NATIVE_COMPACTION_KIND, details(publicModel, [checkpoint()]));
    else session.appendCompaction("LOCAL", user, 10000, details(publicModel, [checkpoint()]), true);
    session.appendMessage({ role: "system", content: "New rules", toolsRemoved: [{ name: "read" }], toolsAdded: [tool("read", "tail"), tool("extra")], timestamp: 3 });
    session.appendMessage({ role: "user", content: "Continue", timestamp: 4 });
    const input = effectiveInputForBranch({ branch: session.getBranch(), model: publicModel, tools: [] });
    const batches = input.filter((item) => item.type === "additional_tools").map((item) => item.tools as any[]);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].map((tool) => [tool.name, tool.description]), [["read", "checkpoint"]]);
    assert.deepEqual(batches[1].map((tool) => [tool.name, tool.description]), [["read", "tail"], ["extra", "extra"]]);
    assert.equal(JSON.stringify(input).includes('"name":"removed"'), false);
    assert.ok(input.some((item) => item.content === "New rules"));

    // A second compaction snapshots the updated state, rather than resurrecting
    // the initial schemas or duplicating already checkpointed tool updates.
    session.appendCompaction("SECOND", user, 10000, details(publicModel, [checkpoint("second")]), true);
    const repeated = effectiveInputForBranch({ branch: session.getBranch(), model: publicModel, tools: [] });
    const tools = repeated.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools as any[]);
    assert.deepEqual(tools.map((tool) => [tool.name, tool.description]), [["read", "tail"], ["extra", "extra"]]);
  }
});

test("older checkpoints without a system snapshot recover tool declarations from their prefix", () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "system", content: "Rules", toolsAdded: [{ name: "read", description: "Read", parameters: Type.Object({}) }], timestamp: 0 });
  const user = session.appendMessage({ role: "user", content: "Inspect Cedar", timestamp: 1 });
  session.appendCompaction("LOCAL", user, 10000, details(publicModel, [checkpoint()]), true);
  const branch = session.getBranch().map((entry) => {
    if (entry.type !== "compaction") return entry;
    const { systemMessage, ...legacy } = entry;
    return legacy;
  });
  const input = effectiveInputForBranch({ branch, model: publicModel, tools: [] });
  assert.deepEqual(input.filter((item) => item.type === "additional_tools").flatMap((item) => (item.tools as any[]).map((tool) => tool.name)), ["read"]);
});

test("replay follows the active checkpoint branch and does not duplicate retained history", () => {
  const session = SessionManager.inMemory("/tmp");
  const old = session.appendMessage({ role: "user", content: "Old pre-checkpoint history", timestamp: 0 });
  const id = session.appendCompaction("LOCAL MARKER", old, 1234, details(), true);
  const tailId = session.appendMessage({ role: "user", content: "Next step", timestamp: 2 });
  const input = effectiveInputForBranch({ branch: session.getBranch(), model: publicModel, tools: [] });
  assert.deepEqual(input.slice(0, 2), [checkpoint(), acknowledgement]);
  assert.equal(input.length, 3);
  assert.equal(JSON.stringify(input).includes("LOCAL MARKER"), false);
  assert.equal(JSON.stringify(input).includes("Old pre-checkpoint history"), false);
  assert.ok(JSON.stringify(input).includes("Next step"));
  assert.throws(() => effectiveInputForBranch({ branch: session.getBranch(), model: codexModel, tools: [] }), /different model/);
  session.branch(id);
  session.appendMessage({ role: "user", content: "Alternative", timestamp: 3 });
  const alternative = effectiveInputForBranch({ branch: session.getBranch(), model: publicModel, tools: [] });
  assert.ok(JSON.stringify(alternative).includes("Alternative"));
  assert.equal(JSON.stringify(alternative).includes("Next step"), false);
  assert.notEqual(session.getLeafId(), tailId);
});

test("native compaction runs through the public hook and restores the current prompt on replay", async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
    assert.equal(body.input.some((item: ResponseItem) => item.type === "compaction_trigger"), false);
    assert.equal(new Headers(options?.headers).has("chatgpt-account-id"), false);
    return sse([checkpoint("early"), acknowledgement, checkpoint("new"), acknowledgement]);
  };
  try {
    // Cache only request shape, not its input: the branch is the source of truth.
    await h.handlers.get("before_provider_request")!({ payload: { model: publicModel.id, input: [{ role: "user", content: "stale cached input" }], tools: [{ type: "function", name: "probe" }] } }, h.ctx);
    const result = await h.handlers.get("session_before_compact")!(h.compactEvent(), h.ctx);
    assert.equal(result.cancel, undefined);
    assert.equal(result.compaction.details.modelKey, modelKey(publicModel));
    assert.deepEqual(result.compaction.details.replacementHistory, [checkpoint("early")]);
    assert.ok(result.compaction.usage);
    h.session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true, result.compaction.usage);
    h.session.appendMessage({ role: "user", content: "Resume now", timestamp: 4 });
    const payload = await h.handlers.get("before_provider_request")!({ payload: { model: publicModel.id, input: [{ role: "user", content: "do not duplicate" }], previous_response_id: "stale" } }, h.ctx);
    assert.deepEqual(payload.input[0], checkpoint("early"));
    assert.equal(payload.instructions, "Current project rules");
    assert.equal(payload.previous_response_id, undefined);
    assert.equal(payload.input.length, 2);
    assert.equal(calls, 1);
    const headers: Record<string, string> = {};
    h.handlers.get("before_provider_headers")!({ headers }, h.ctx);
    assert.deepEqual(headers, {});
    const context = h.handlers.get("context")!({ messages: [{ role: "compactionSummary", summary: "LOCAL" }, { role: "user", content: "Resume now" }] }, h.ctx);
    assert.deepEqual(context.messages, [{ role: "user", content: "Resume now" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("failed public compaction cancels without changing history or falling back silently", async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  const before = h.session.getBranch();
  globalThis.fetch = async () => new Response('{"error":{"message":"Unauthorized"}}', { status: 401 });
  try {
    const result = await h.handlers.get("session_before_compact")!(h.compactEvent(), h.ctx);
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(h.session.getBranch(), before);
    assert.ok(h.notifications.some((message) => message.includes("401")));
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed, incomplete and missing public checkpoints fail closed", async () => {
  await assert.rejects(callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => sse([acknowledgement]) }), /no pre-generation compaction checkpoint/);
  await assert.rejects(callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    fetchImpl: async () => sse([checkpoint()], { finalOutput: [{ invalid: true }] }) }), /malformed inline/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: publicModel,
    signal: controller.signal, fetchImpl: async () => { calls++; controller.abort(); return sse([checkpoint()], { completed: false }); } }), /closed before response.completed/);
  assert.equal(calls, 1);
});

test("unsupported provider switches abort instead of continuing with a local marker", async () => {
  const h = harness();
  h.session.appendCustomEntry(NATIVE_COMPACTION_KIND, details());
  const other = { ...h.ctx, model: { ...publicModel, provider: "other" } };
  await h.handlers.get("before_provider_request")!({ payload: { input: [] } }, other);
  assert.equal(h.aborted(), true);
  assert.ok(h.notifications.some((message) => message.includes("Switch back")));
});

test("retained pre-checkpoint context edits still block opaque replay", () => {
  const session = SessionManager.inMemory("/tmp");
  const target = session.appendMessage({ role: "user", content: "Retained user turn", timestamp: 1 });
  session.appendCompaction("LOCAL", target, 1234, details(), true);
  const branch = [...session.getBranch(), { type: "context_edit", id: "edit", parentId: session.getLeafId(), targetId: target, timestamp: new Date().toISOString(), operation: "omit" }] as unknown as SessionEntry[];
  assert.throws(() => effectiveInputForBranch({ branch, model: publicModel, tools: [] }), /context edit/);
});

test("Codex keeps its previous trigger, headers and user-retention semantics", async () => {
  const input = [{ role: "user", content: "User requirement" }, { role: "assistant", content: "Old assistant output" }];
  assert.deepEqual(buildReplacementHistory(input, checkpoint()), [input[0], checkpoint()]);
  const result = await callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: codexModel,
    fetchImpl: async () => sse([checkpoint()]) });
  assert.equal(result.replacementHistory, undefined);
  assert.deepEqual(result.compactionItem, checkpoint());
  await assert.rejects(callRemoteCompaction({ url: "https://example.invalid", headers: new Headers(), body: {}, model: codexModel,
    fetchImpl: async () => sse([checkpoint(), checkpoint("second")]) }), /expected exactly one/);
  const h = harness(codexModel);
  const headers: Record<string, string> = {};
  h.handlers.get("before_provider_headers")!({ headers }, h.ctx);
  assert.equal(headers["x-codex-beta-features"], "remote_compaction_v2");
});
