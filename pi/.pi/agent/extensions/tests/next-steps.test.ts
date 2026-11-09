import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEventBus, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import nextSteps from "../next-steps/index.ts";
import {
  MARKER, MAX_STEP_CHARS, NEXT_STEPS_GUIDANCE, SETTINGS_TYPE, parseNextSteps, stateFromBranch, visibleReply,
} from "../next-steps/core.ts";

const block = (steps: unknown) => `${MARKER}\n${JSON.stringify(steps)}\n-->`;
const reply = (steps: unknown = ["Review the diff", "Add retry coverage"]) => `Implemented and tested.\n\n${block(steps)}`;
const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text, textSignature: "opaque-provider-signature" }],
  api: "openai-responses", provider: "openai", model: "gpt-6.1-sol", stopReason, timestamp: 1,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("next-step parser extracts only a trailing standalone JSON payload", () => {
  assert.deepEqual(parseNextSteps(reply()), { content: "Implemented and tested.", steps: ["Review the diff", "Add retry coverage"] });
  assert.deepEqual(parseNextSteps("An ordinary reply.\n"), { content: "An ordinary reply.\n", steps: [] });
  for (const text of [
    `Example: ${block(["Do not pick"])} `,
    `${reply()}\nMore visible prose.`,
    `${reply()}\n${MARKER}-not-the-marker`,
    `${MARKER}\n["Do not pick"] -->\nvisible\n-->`,
    `    ${MARKER}\n["indented code"]\n-->`,
  ]) assert.deepEqual(parseNextSteps(text), { content: text, steps: [] });
  assert.deepEqual(parseNextSteps(reply().replaceAll("\n", "\r\n") + "\r\n "), {
    content: "Implemented and tested.", steps: ["Review the diff", "Add retry coverage"],
  });
});

test("next-step parser does not turn code samples or inline mentions into suggestions", () => {
  for (const [open, close] of [["```md", "```"], ["~~~~markdown", "~~~~"], ["````md", "````"]]) {
    const text = `Here is the format:\n${open}\n${block(["An example"])}\n${close}`;
    assert.equal(visibleReply(text, false), text);
    assert.deepEqual(parseNextSteps(text).steps, []);
    assert.equal(visibleReply(`Example:\n${open}\n${MARKER}\n[`, true), `Example:\n${open}\n${MARKER}\n[`);
  }
  const text = `Example:\n\`\`\`md\n${block(["An example"])}\n\`\`\`\n\nActual answer.\n${block(["Actual next step"])}`;
  assert.deepEqual(parseNextSteps(text).steps, ["Actual next step"]);
});

test("invalid and excessive payloads are hidden without inventing actions", () => {
  for (const payload of ['["unfinished"', '{"steps":["not an array"]}', 'null', '42', '"plain text"', " ".repeat(8_193) + "[]"]) {
    const text = `Done.\n${MARKER}\n${payload}\n-->`;
    assert.deepEqual(parseNextSteps(text), { content: "Done.", steps: [] });
    assert.equal(visibleReply(text, false), "Done.");
  }
  assert.deepEqual(parseNextSteps(reply([])), { content: "Implemented and tested.", steps: [] });
});

test("suggestions are bounded, deduplicated, and cannot become shell/slash shortcuts", () => {
  const parsed = parseNextSteps(reply([
    null, 1, {}, "", " /reload", " !rm -rf /tmp/example", "\u001b[31mANSI", "\u202eevil", "x".repeat(MAX_STEP_CHARS + 1),
    " Review  the\ndiff ", "review the diff", "Add retry coverage", "Check the preview", "Ignored fourth choice",
  ]));
  assert.deepEqual(parsed.steps, ["Review the diff", "Add retry coverage", "Check the preview"]);
  assert.deepEqual(parseNextSteps(reply(["x".repeat(MAX_STEP_CHARS)])).steps, ["x".repeat(MAX_STEP_CHARS)]);
});

test("only the last complete block is stripped; earlier content stays intact", () => {
  const prior = `${block(["Earlier"])}\nSome prose.`;
  assert.deepEqual(parseNextSteps(`${prior}\n${block(["Latest"])}`), { content: prior, steps: ["Latest"] });
});

test("streaming metadata and aborted partial payloads never leak into the rendered reply", () => {
  const payload = block(["Review the diff"]);
  for (let at = 4; at <= payload.length; at++) {
    assert.equal(visibleReply(`Done.\n\n${payload.slice(0, at)}`, true), "Done.", `partial at ${at}`);
  }
  assert.equal(visibleReply(`Done.\n${MARKER}\n["unfinished`, false), "Done.");
  assert.equal(visibleReply(`Done.\n<!-- pi-other`, true), "Done.\n<!-- pi-other");
});

test("branch state uses only the latest relevant message and branch-local settings", () => {
  const sm = SessionManager.inMemory("/tmp");
  const first = sm.appendMessage(assistant(reply()));
  sm.appendCustomEntry(SETTINGS_TYPE, { enabled: false });
  assert.equal(stateFromBranch(sm.getBranch()).enabled, false);
  sm.branch(first);
  assert.equal(stateFromBranch(sm.getBranch()).enabled, true);
  assert.deepEqual(stateFromBranch(sm.getBranch()).steps, ["Review the diff", "Add retry coverage"]);
  sm.appendCustomEntry("unrelated", { status: "done" });
  assert.equal(stateFromBranch(sm.getBranch()).sourceId, first);
  sm.appendMessage({ role: "user", content: "New question", timestamp: 2 });
  assert.deepEqual(stateFromBranch(sm.getBranch()).steps, []);
  sm.appendMessage(assistant("Plain reply without suggestions"));
  assert.deepEqual(stateFromBranch(sm.getBranch()).steps, []);
});

test("failed, aborted, tool-calling, or truncated replies never offer next steps", () => {
  for (const reason of ["error", "aborted", "length", "toolUse", "pending", "deferred"] as const) {
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage(assistant(reply()));
    sm.appendMessage(assistant(reply(["Do not offer"]), reason));
    assert.deepEqual(stateFromBranch(sm.getBranch()).steps, [], reason);
  }
  const sm = SessionManager.inMemory("/tmp");
  const message = assistant(reply());
  message.content.push({ type: "toolCall", id: "test", name: "bash", arguments: {} });
  sm.appendMessage(message);
  assert.deepEqual(stateFromBranch(sm.getBranch()).steps, []);
});

function harness(mode = "tui", sm = SessionManager.inMemory("/tmp")) {
  const handlers = new Map<string, ((event: any, ctx: ExtensionCommandContext) => unknown)[]>();
  let command: any;
  let transform: MarkdownTransformer;
  let widget: Component | undefined;
  let draft = "";
  let idle = true;
  let pending = false;
  const answers: (string | number | undefined)[] = [];
  const notifications: string[] = [];
  const sends: { text: string; options: unknown }[] = [];
  const selections: string[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  let select: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => {
    const answer = answers.shift();
    return typeof answer === "number" ? options[answer] : answer;
  };
  const events = createEventBus();
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", sessionManager: sm,
    model: { provider: "openai", id: "gpt-6.1-sol" },
    isIdle: () => idle, hasPendingMessages: () => pending,
    ui: {
      theme, notify: (text: string) => notifications.push(text),
      setWidget: (_key: string, factory: any) => { widget = factory?.({}, theme); },
      getEditorText: () => draft, setEditorText: (text: string) => { draft = text; },
      select: (title: string, options: string[]) => { selections.push(title); return select(title, options); },
    },
  } as unknown as ExtensionCommandContext;
  nextSteps({
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerMarkdownTransformer: (fn: MarkdownTransformer) => { transform = fn; },
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data), events,
    sendUserMessage: (text: string, options: unknown) => sends.push({ text, options }),
  } as unknown as ExtensionAPI);
  return {
    ctx, sm, answers, notifications, sends, events, selections,
    get widget() { return widget; }, get draft() { return draft; }, set draft(value) { draft = value; },
    set idle(value: boolean) { idle = value; }, set pending(value: boolean) { pending = value; },
    set select(fn: typeof select) { select = fn; },
    async emit(name: string, event: any = {}) { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); },
    async command(args = "") { await command.handler(args, ctx); },
    render(text: string, messageType: "assistant" | "user" | "assistant-thinking" = "assistant", streaming = false) {
      return transform(text, { messageType, isStreaming: streaming, availableWidth: 80 });
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("extension adds one stable prompt section without replacing the system prompt or calling a model", async () => {
  const h = harness();
  await h.emit("session_start");
  const event = { messageType: "user", systemPrompt: "Do not replace me", systemPromptOptions: { sections: { custom: "Keep me" } } };
  await h.emit("before_agent_start", event);
  assert.equal(event.systemPrompt, "Do not replace me");
  assert.deepEqual(event.systemPromptOptions.sections, { custom: "Keep me", next_steps: NEXT_STEPS_GUIDANCE });
  assert.match(NEXT_STEPS_GUIDANCE, /Omit it when the task is naturally finished/);
  assert.deepEqual(h.sends, []);
  await h.emit("before_agent_start", { ...event, messageType: "custom" });
  assert.deepEqual(event.systemPromptOptions.sections, { custom: "Keep me" });
});

test("display transform leaves user messages, code examples, and provider metadata unchanged", async () => {
  const h = harness();
  const message = assistant(reply());
  const original = structuredClone(message);
  h.sm.appendMessage(message);
  await h.emit("session_start");
  assert.equal(h.render(reply()), "Implemented and tested.");
  assert.equal(h.render(reply(), "user"), reply());
  assert.equal(h.render(reply(), "assistant-thinking"), reply());
  assert.deepEqual(message, original);
  assert.deepEqual(h.sm.getBranch().at(-1)?.type, "message");
  assert.deepEqual(h.sends, []);
});

test("widget appears only when finally settled, restores from history, and fits narrow terminals", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply(["Review 日本語 and 👩‍💻 edge cases", "Add retry coverage"])));
  await h.emit("session_start");
  assert.ok(h.widget);
  for (const width of [0, 1, 4, 15, 25, 80, 160]) for (const line of h.widget.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  await h.emit("agent_start");
  assert.equal(h.widget, undefined);
  await h.emit("agent_end");
  assert.equal(h.widget, undefined, "agent_end can precede a retry/continuation");
  await h.emit("agent_settled", { aborted: false });
  assert.ok(h.widget);
  h.sm.appendMessage(assistant("No useful next step."));
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.widget, undefined, "must not revive the previous reply's suggestions");
});

test("picker inserts without sending and never overwrites a draft", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  h.answers.push(0);
  await h.command();
  assert.equal(h.draft, "Review the diff");
  assert.deepEqual(h.sends, []);
  h.draft = "Keep this draft";
  h.answers.push("Cancel");
  await h.command("2");
  assert.equal(h.draft, "Keep this draft");
  h.answers.push("Append to draft");
  await h.command("2");
  assert.equal(h.draft, "Keep this draft\n\nAdd retry coverage");
  assert.deepEqual(h.sends, []);
});

test("cancelled picker and out-of-range choices leave the editor alone", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply(["Only one"])));
  await h.emit("session_start");
  h.draft = "Unchanged";
  await h.command();
  await h.command("3");
  await h.command("unexpected");
  assert.equal(h.draft, "Unchanged");
  assert.deepEqual(h.sends, []);
});

test("send is explicit, stays in this chat, disables command expansion, and preserves the draft", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  h.draft = "Unsent draft";
  await h.command("send 2");
  assert.deepEqual(h.sends, [{ text: "Add retry coverage", options: { expandPromptTemplates: false } }]);
  assert.equal(h.draft, "Unsent draft");
  assert.equal(h.widget, undefined);
});

test("busy and pending sessions cannot send, queue, or insert a suggestion", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  h.idle = false;
  await h.command("send 1");
  h.idle = true;
  h.pending = true;
  await h.command("1");
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.selections, []);
  assert.equal(h.draft, "");
});

test("stale picker results after a turn, tree change, or shutdown never mutate the editor", async () => {
  for (const event of ["agent_start", "session_tree", "session_shutdown"]) {
    const h = harness();
    h.sm.appendMessage(assistant(reply()));
    await h.emit("session_start");
    let resolve!: (text: string) => void;
    h.select = () => new Promise((done) => { resolve = done; });
    const choice = h.command();
    await h.emit(event);
    resolve("Review the diff");
    await choice;
    assert.equal(h.draft, "", event);
    assert.deepEqual(h.sends, []);
  }
});

test("a new user message or changed draft during a picker invalidates insertion", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  let resolve!: (text: string) => void;
  h.select = () => new Promise((done) => { resolve = done; });
  const stale = h.command();
  h.sm.appendMessage({ role: "user", content: "Something else", timestamp: 3 });
  resolve("Review the diff");
  await stale;
  assert.equal(h.draft, "");
  h.sm.appendMessage(assistant(reply()));
  await h.emit("agent_settled", { aborted: false });
  h.draft = "Draft before dialog";
  const changedDraft = h.command("1");
  h.draft = "A newer draft";
  resolve("Append to draft");
  await changedDraft;
  assert.equal(h.draft, "A newer draft");
});

test("off/on persists in session history and restores correctly across reload and tree navigation", async () => {
  const h = harness();
  const original = h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  await h.command("off");
  assert.equal(h.widget, undefined);
  const event = { messageType: "user", systemPromptOptions: { sections: { next_steps: "old guidance" } } };
  await h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  const reloaded = harness("tui", h.sm);
  await reloaded.emit("session_start");
  assert.equal(reloaded.widget, undefined);
  await reloaded.command("status");
  assert.match(reloaded.notifications.at(-1)!, /off.*openai\/gpt-6.1-sol.*no extra model call/);
  await reloaded.command("on");
  assert.ok(reloaded.widget);
  h.sm.branch(original);
  await h.emit("session_tree");
  assert.ok(h.widget);
  assert.equal(h.render(reply()), "Implemented and tested.", "old payloads stay hidden even while off");
});

test("prefix event and fullscreen click insert into the editor, not into the model", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  h.answers.push(1);
  h.events.emit("next-steps:pick", undefined);
  await tick();
  assert.equal(h.draft, "Add retry coverage");
  h.draft = "";
  const widget = h.widget!;
  widget.handleMouse!({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 3,
    screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false });
  await tick();
  assert.equal(h.draft, "Review the diff");
  assert.deepEqual(h.sends, []);
  await h.emit("session_shutdown");
  h.draft = "";
  h.events.emit("next-steps:pick", undefined);
  await tick();
  assert.equal(h.draft, "", "shutdown must unsubscribe from the event bus");
});

test("duplicate picker requests do not open overlapping dialogs", async () => {
  const h = harness();
  h.sm.appendMessage(assistant(reply()));
  await h.emit("session_start");
  let resolve!: (text: string | undefined) => void;
  h.select = () => new Promise((done) => { resolve = done; });
  const one = h.command();
  await h.command();
  assert.equal(h.selections.length, 1);
  resolve(undefined);
  await one;
});

test("print, JSON, and RPC runs get no suggestion prompt, widget, or extra work", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(mode);
    h.sm.appendMessage(assistant(reply()));
    await h.emit("session_start");
    const event = { messageType: "user", systemPromptOptions: { sections: { next_steps: "old" } } };
    await h.emit("before_agent_start", event);
    await h.emit("agent_settled", { aborted: false });
    await h.command();
    assert.deepEqual(event.systemPromptOptions.sections, {});
    assert.equal(h.widget, undefined);
    assert.deepEqual(h.sends, []);
    assert.deepEqual(h.selections, []);
  }
});
