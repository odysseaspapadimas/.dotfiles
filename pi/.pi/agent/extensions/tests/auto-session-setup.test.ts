import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoSetup from "../auto-session-setup.ts";

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const names: string[] = [];
  const warnings: string[] = [];
  let finish: (result: any) => void = () => {};
  let signal: AbortSignal | undefined;
  const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => "test-session" }, ui: {
    notify: (message: string) => warnings.push(message),
  }, modelRegistry: {
    find: () => ({ id: "deepseek-v4.1-flash" }), getAll: () => [],
    complete: (_model: any, _context: any, options: any) => {
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    },
  } };
  autoSetup({ on: (name: string, handler: any) => handlers.set(name, handler),
    getSessionName: () => undefined, setSessionName: (name: string) => names.push(name),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI);
  return { names, warnings, get signal() { return signal; },
    finish: () => finish({ content: [{ type: "text", text: "Generated name" }], stopReason: "stop" }),
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx) };
}

// Keep test execution isolated from the invoking Pi/Herdr session.
delete process.env.PI_HERDR_SIDE;
delete process.env.HERDR_ENV;

test("session naming completes once without renaming a resumed or reloaded session", async () => {
  const state = setup();
  state.emit("session_start", { reason: "reload" });
  await state.emit("before_agent_start", { prompt: "Existing session" });
  assert.deepEqual(state.names, []);
  state.emit("session_start", { reason: "new" });
  await state.emit("before_agent_start", { prompt: "A new session\nDetails" });
  assert.deepEqual(state.names, ["A new session"]);
  state.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.names, ["A new session", "Generated name"]);
  await state.emit("before_agent_start", { prompt: "Second turn" });
  assert.equal(state.names.length, 2);
});

test("shutdown cancels background naming and ignores a late response from a stale runtime", async () => {
  const state = setup();
  state.emit("session_start", { reason: "new" });
  await state.emit("before_agent_start", { prompt: "Fallback name" });
  assert.equal(state.signal?.aborted, false);
  state.emit("session_shutdown");
  assert.equal(state.signal?.aborted, true);
  state.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.names, ["Fallback name"]);
  assert.deepEqual(state.warnings, []);
});
