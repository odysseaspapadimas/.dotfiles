import assert from "node:assert/strict";
import { test } from "node:test";
import { FooterComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import cleanFooter from "../clean-footer.ts";
import fastMode from "../codex-fast-mode/index.ts";

const theme = {
  fg: (color: string, value: string) => `\x1b[${color === "accent" ? "36" : "2"}m${value}\x1b[0m`,
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
};

function setup() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const statuses = new Map<string, string>([
    ["context-usage", "context 日本語 ".repeat(40)],
    ["pi-sessions", "workers ".repeat(40)],
    ["token-speed", "speed ".repeat(40)],
  ]);
  let footer: any;
  const footerData = {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    onBranchChange: () => () => {},
  };
  const ctx = {
    mode: "tui", cwd: "/tmp/very-long-footer-test-directory",
    model: { id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses", reasoning: true, contextWindow: 1_000_000 },
    isIdle: () => true,
    getContextUsage: () => ({ percent: 5, contextWindow: 1_000_000 }),
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getHeader: () => ({ timestamp: new Date().toISOString() }),
      getSessionId: () => "footer-test", getLeafId: () => "leaf",
      getCwd: () => "/tmp/very-long-footer-test-directory", getSessionName: () => "footer test",
      getEntries: () => entries, getBranch: () => entries, getEntryCount: () => entries.length,
    },
    ui: {
      theme, notify() {},
      setStatus: (key: string, value: string | undefined) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter: (factory: any) => {
        footer?.dispose();
        footer = factory?.({ requestRender() {} }, theme, footerData);
      },
    },
  };
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getSettings: () => ({}), getThinkingLevel: () => "xhigh",
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  cleanFooter(pi);
  fastMode(pi);
  const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, ctx); };
  emit("session_start");
  return { ctx, footerData, emit, command: (args: string) => commands.get("fast").handler(args, ctx),
    render: (width: number) => footer.render(width) as string[] };
}

function checkMarker(render: (width: number) => string[], marker: string) {
  for (const width of [0, 1, 3, 4, 6, 14, 15, 16, 20, 40, 60, 80, 100, 160]) {
    const lines = render(width);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    if (width >= 4) {
      const text = stripTerminalSequences(lines.join("\n"));
      assert.equal(text.match(/\bfast\b/g)?.length, 1, `one marker at ${width}: ${text}`);
    }
    if (width >= marker.length) {
      assert.ok(stripTerminalSequences(lines[2]).includes(marker), `marker is not truncated at ${width}`);
    }
    if (width >= 40) {
      assert.match(stripTerminalSequences(lines[2]), /fast(?: \(inactive\))? · \d+m · 0 turns/,
        "Fast Mode is immediately left of the session lifetime");
      if (marker === "fast") assert.ok(lines[2].includes(theme.fg("accent", "fast")), "active marker uses the accent color");
    }
  }
}

test("the rich footer reserves Fast Mode space despite crowded statuses and narrow widths", async () => {
  const { command, emit, render } = setup();
  try {
    assert.doesNotMatch(stripTerminalSequences(render(80).join("\n")), /\bfast\b/);
    await command("on");
    checkMarker(render, "fast");
    await command("off");
    assert.doesNotMatch(stripTerminalSequences(render(80).join("\n")), /\bfast\b/);
  } finally {
    emit("session_shutdown");
  }
});

test("the rich footer shows an accent marker on OpenAI and an inactive marker on unrelated providers", async () => {
  const { ctx, command, emit, render } = setup();
  try {
    ctx.model.provider = "other";
    ctx.model.api = "openai-responses";
    await command("on");
    checkMarker(render, "fast (inactive)");
    ctx.model.provider = "openai";
    emit("model_select");
    checkMarker(render, "fast");
    assert.doesNotMatch(stripTerminalSequences(render(80).join("\n")), /inactive/);
  } finally {
    emit("session_shutdown");
  }
});

test("Pi's default footer keeps Fast Mode visible before long extension statuses", async () => {
  initTheme("dark", false);
  const { ctx, command, emit, footerData } = setup();
  const footer = new FooterComponent({
    get state() { return { model: ctx.model, thinkingLevel: "xhigh" }; },
    get model() { return ctx.model; },
    sessionManager: ctx.sessionManager,
    modelRuntime: { isUsingSubscription: () => false },
    getContextUsage: ctx.getContextUsage,
  } as any, footerData);
  try {
    await command("on");
    for (const width of [20, 40, 80, 160]) {
      assert.match(stripTerminalSequences(footer.render(width)[2]), /^fast /);
    }
    ctx.model.provider = "openai";
    ctx.model.api = "openai-responses";
    emit("model_select");
    assert.match(stripTerminalSequences(footer.render(40)[2]), /^fast /);
    ctx.model.id = "gpt-6-mini";
    emit("model_select");
    assert.match(stripTerminalSequences(footer.render(40)[2]), /^fast \(inactive\)/);
    await command("off");
    assert.doesNotMatch(stripTerminalSequences(footer.render(80).join("\n")), /\bfast\b/);
  } finally {
    footer.dispose();
    emit("session_shutdown");
  }
});
