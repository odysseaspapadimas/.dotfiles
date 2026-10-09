import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import ctrlX from "../ctrl-x-prefix.ts";
import fileViewer from "../file-viewer/index.ts";

delete process.env.PI_HERDR_SIDE;
delete process.env.HERDR_ENV;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const fits = (component: any, widths: number[]) => {
  for (const width of widths) for (const line of component.render(width)) {
    assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: ${line}`);
  }
};

test("Ctrl+X chords work with Pi 1.0's CustomEditor and preserve drafts", async () => {
  const handlers = new Map<string, any>();
  let editor: any;
  let copied = 0;
  let helpClosed = false;
  const submitted: string[] = [];
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
  const ctx = { mode: "tui", ui: { theme, notify() {}, getEditorComponent: () => undefined,
    setEditorComponent: (factory: any) => { editor = factory(tui, { borderColor: (value: string) => value, selectList: {} }, { matches: () => false }); },
    custom: async (factory: any) => {
      const help = factory(tui, theme, {}, () => { helpClosed = true; });
      fits(help, [1, 10, 19, 20, 40, 64, 100]);
      help.handleInput("\x1b");
    },
  } };
  ctrlX({ on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand() {},
  } as unknown as ExtensionAPI);
  handlers.get("session_start")({}, ctx);
  editor.actionHandlers.set("app.message.copy", () => copied++);
  editor.onSubmit = async (command: string) => { submitted.push(command); editor.setText(""); };
  try {
    editor.handleInput("\x18"); editor.handleInput("c");
    assert.equal(copied, 1);
    editor.setText("Keep this draft");
    editor.handleInput("\x18"); editor.handleInput("s");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(submitted, ["/settings"]);
    assert.equal(editor.getText(), "Keep this draft");
    for (const [key, command] of [["a", "/subagents"], ["h", "/subagents-toggle"], ["H", "/share"]]) {
      editor.handleInput("\x18"); editor.handleInput(key);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(submitted.at(-1), command);
      assert.equal(editor.getText(), "Keep this draft", `${key} must preserve the draft`);
    }
    editor.handleInput("\x18"); editor.handleInput("?");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(helpClosed, true);
  } finally {
    handlers.get("session_shutdown")({}, ctx);
  }
});

test("the standalone file overlay fits narrow terminals and closes cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-viewer-tui-"));
  let command: any;
  let closed = false;
  const warnings: string[] = [];
  fileViewer({ registerCommand: (_name: string, definition: any) => { command = definition; },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI);
  try {
    await writeFile(join(root, "a-very-long-filename-日本語.txt"), "hello\nworld\n");
    await command.handler("a-very-long-filename-日本語.txt:2", { cwd: root, mode: "tui", ui: {
      notify: (message: string) => warnings.push(message),
      custom: async (factory: any) => {
        const viewer = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, () => { closed = true; });
        fits(viewer, [0, 1, 4, 10, 20, 40, 80, 160]);
        viewer.handleInput("\x1b");
      },
    } });
    assert.deepEqual(warnings, []);
    assert.equal(closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
