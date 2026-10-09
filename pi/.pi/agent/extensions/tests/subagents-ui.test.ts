import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { registerSubagentUI, workerRow, widgetRows, type WorkerRow } from "../pi-sessions/ui.ts";
import type { SessionSnapshot } from "../pi-sessions/store.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function snapshot(id = "child"): SessionSnapshot {
  return { session: { id, sessionId: id, name: `Worker ${id}`, sessionPath: `/tmp/${id}.jsonl`, cwd: "/tmp",
    parentSessionId: "parent", lifecycle: "task", createdAt: 1, updatedAt: 1, orchestrated: true, origin: "created" },
    messages: [{ id: "u", role: "user", text: "task", timestamp: 1 },
      { id: "a", role: "assistant", text: "Saved result\n" + "line\n".repeat(50), timestamp: 2, stopReason: "stop" }],
    userEntryIds: new Set(["u"]), settled: [{ sessionId: id, userEntryId: "u", assistantEntryId: "a", outcome: "completed" }] };
}
function harness() {
  let command: any;
  let toggleCommand: any;
  let rows: WorkerRow[] = [workerRow(snapshot("a"), "working"), workerRow(snapshot("b"), "blocked"), workerRow(snapshot("c"), "stopped")];
  let loader = async (_parent: string, _signal: AbortSignal) => rows;
  let component: any;
  let done: any;
  const widgets = new Map<string, any>();
  const placements: string[] = [];
  const notices: string[] = [];
  const opens: any[] = [];
  const controller = registerSubagentUI({ registerCommand: (name: string, value: any) => {
    if (name === "subagents") command = value;
    else { assert.equal(name, "subagents-toggle"); toggleCommand = value; }
  } } as unknown as ExtensionAPI, {
    parentId: async () => "parent",
    rows: (parent, signal) => loader(parent, signal),
    open: async (...args) => { opens.push(args); },
  });
  const ctx = { mode: "tui", hasUI: true, ui: {
    notify: (message: string) => notices.push(message),
    setWidget: (key: string, value: any, options: any) => {
      if (value) { widgets.set(key, value); placements.push(options.placement); } else widgets.delete(key);
    },
    custom: (factory: any) => new Promise((resolve) => {
      done = resolve;
      component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme,
        { matches: (data: string, action: string) => action === "tui.select.cancel" && matchesKey(data, "escape") }, resolve);
    }),
  } } as unknown as ExtensionContext;
  return { ctx, controller, widgets, placements, notices, opens,
    set rows(value: WorkerRow[]) { rows = value; }, set loader(value: typeof loader) { loader = value; },
    get component() { return component; },
    toggle: () => toggleCommand.handler("", ctx),
    async picker() { const promise = command.handler("", ctx); await new Promise((resolve) => setImmediate(resolve)); return { promise }; },
    close() { done(undefined); },
    widget: () => widgets.get("pi-subagents")?.({}, theme).render(100).join("\n") ?? "",
  };
}

test("live states override old completion; outcomes survive runtime cleanup", () => {
  const s = snapshot();
  assert.equal(workerRow(s, "working").state, "running");
  assert.equal(workerRow(s, "blocked").state, "blocked");
  assert.equal(workerRow(s, "stopped").state, "done");
  assert.equal(workerRow(s, "idle").state, "idle", "reopened history is a live idle session");
  assert.equal(workerRow(s, "done").state, "idle", "Herdr done still identifies a live runtime");
  assert.equal(widgetRows([workerRow(s, "idle")]).length, 1);
  assert.equal(workerRow(s, "multiple").state, "multiple");
  assert.equal(workerRow(s, "unknown").state, "unknown");
  s.settled[0].outcome = "failed";
  assert.equal(workerRow(s, "stopped").state, "failed");
  s.settled[0].outcome = "aborted";
  assert.equal(workerRow(s, "idle").state, "aborted");
  s.settled = [];
  assert.equal(workerRow(s, "stopped").state, "stopped");
  assert.equal(widgetRows([workerRow(snapshot(), "stopped")]).length, 0);
});

test("j/k navigate real rows, completion removes widget entry, result remains scrollable", async () => {
  const h = harness();
  try {
    await h.controller.start(h.ctx);
    assert.ok(h.placements.every((placement) => placement === "aboveEditor"));
    assert.match(h.widget(), /Worker a \(running\)/);
    assert.doesNotMatch(h.widget(), /Worker c/);
    const { promise } = await h.picker();
    h.component.handleInput("j");
    h.component.handleInput("f");
    await promise;
    assert.deepEqual(h.opens[0].slice(0, 3), ["parent", "/tmp/b.jsonl", false]);
    const next = await h.picker();
    h.component.handleInput("j"); h.component.handleInput("k");
    h.component.handleInput("r"); await next.promise;
    assert.deepEqual(h.opens[1].slice(0, 3), ["parent", "/tmp/a.jsonl", true]);
    const last = await h.picker();
    h.rows = [workerRow(snapshot("a"), "stopped")];
    await h.controller.refresh();
    assert.equal(h.widget(), "");
    assert.match(h.component.render(72).join("\n"), /done · saved/);
    h.rows = [workerRow(snapshot("a"), "idle")];
    await h.controller.refresh();
    assert.match(h.widget(), /Worker a \(idle\)/, "reopening remounts the tree without another prompt");
    h.component.handleInput("\r");
    const before = h.component.render(72).join("\n");
    h.component.handleInput("j");
    assert.notEqual(h.component.render(72).join("\n"), before);
    h.component.handleInput("k");
    assert.equal(h.component.render(72).join("\n"), before);
    for (const width of [0, 1, 4, 10, 40, 72]) for (const line of h.component.render(width)) assert.ok(visibleWidth(line) <= width);
    h.component.handleInput("\x1b"); h.component.handleInput("\x1b");
    await last.promise;
  } finally { h.controller.stop(); }
});

test("late refresh cannot publish into a replacement session; errors preserve last known rows", async () => {
  const h = harness();
  try {
    await h.controller.start(h.ctx);
    h.loader = async () => { throw new Error("snapshot unavailable"); };
    await h.controller.refresh();
    assert.match(h.widget(), /Status unavailable/);
    assert.match(h.widget(), /Worker a/);
    let resolve: any;
    h.loader = () => new Promise((done) => { resolve = done; });
    const loading = h.controller.refresh();
    h.controller.stop();
    resolve([workerRow(snapshot("late"), "working")]);
    await loading;
    assert.equal(h.widgets.size, 0);
  } finally { h.controller.stop(); }
});

test("hiding survives refreshes, keeps the picker available, and restores current rows", async () => {
  const h = harness();
  try {
    await h.controller.start(h.ctx);
    assert.match(h.widget(), /Worker a/);
    await h.toggle();
    assert.equal(h.widgets.size, 0);
    h.rows = [workerRow(snapshot("new"), "working")];
    await h.controller.refresh();
    assert.equal(h.widgets.size, 0, "background polling must not remount a hidden tree");
    const { promise } = await h.picker();
    assert.match(h.component.render(72).join("\n"), /Worker new/);
    assert.equal(h.widgets.size, 0, "opening the picker must not unhide the tree");
    h.component.handleInput("\x1b"); await promise;
    await h.toggle();
    assert.match(h.widget(), /Worker new/);
    assert.doesNotMatch(h.widget(), /Worker a/);
    await h.toggle();
    await h.controller.start(h.ctx);
    assert.match(h.widget(), /Worker new/, "a new foreground binding starts visible");
  } finally { h.controller.stop(); }
});

test("empty picker and headless mode are safe; render strips terminal control sequences", async () => {
  const h = harness();
  try {
    await h.controller.start({ ...h.ctx, mode: "json" });
    assert.equal(h.widgets.size, 0);
    h.rows = [];
    await h.controller.start(h.ctx);
    const { promise } = await h.picker();
    assert.match(h.component.render(72).join("\n"), /No child sessions/);
    for (const width of [0, 1, 4, 10, 40, 72]) for (const line of h.component.render(width)) assert.ok(visibleWidth(line) <= width);
    h.component.handleInput("\x1b"); await promise;
    const s = snapshot(); s.messages[1].text = "\x1b[31mred\x1b[0m\r\x00";
    assert.equal(workerRow(s, "stopped").result, "red");
  } finally { h.controller.stop(); }
});
