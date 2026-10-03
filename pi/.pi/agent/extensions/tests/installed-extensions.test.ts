import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

// This suite checks the actual configured packages through Pi's real jiti loader
// and SDK runner. It never prompts a model or controls a live Herdr pane.
test("all configured extensions load and complete a Pi 1.0 lifecycle", async () => {
  const agentDir = process.env.PI_TEST_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const configured = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "pi-extension-compatibility-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HERDR_") || key.startsWith("PI_HERDR_SIDE")) delete process.env[key];
  }
  initTheme("dark", false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 503 });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const errors: ExtensionError[] = [];
  try {
    const settingsManager = SettingsManager.inMemory(configured);
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions.length >= 14, "all local entry points should be discovered");
    const created = await createAgentSession({
      cwd: root, agentDir: join(root, "agent"), resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(root), model: getModel("openai-codex", "gpt-6.1-sol"),
      sessionStartEvent: { type: "session_start", reason: "reload" },
    });
    session = created.session;
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    const runner = session.extensionRunner;
    assert.deepEqual(runner.getCommandDiagnostics(), []);
    for (const name of ["fast", "activity", "context", "skills", "side", "view", "codex-review", "diff", "checkpoints"]) assert.ok(runner.getCommand(name), name);
    for (const name of ["pi_sessions", "ask_user_question", "todo", "web_enable"]) assert.ok(runner.getToolDefinition(name), name);

    const sessionsTool = runner.getToolDefinition("pi_sessions")!;
    assert.ok(sessionsTool.outputSchema);
    const probe = await sessionsTool.execute("structured-session-probe", { action: "list" },
      undefined, undefined, runner.createToolContext("structured-session-probe", undefined));
    assert.equal((probe.structuredContent as { action: string }).action, "list");

    await runner.emitBeforeAgentStart("compatibility probe", undefined, { cwd: root, selectedTools: [] });
    const messages = await runner.emitContext([
      { role: "system", content: "Compatibility test", timestamp: 0 },
      { role: "user", content: "probe", timestamp: 1 },
    ]);
    assert.equal(messages[0].role, "system");
    const payload = { model: "gpt-6.1-sol", input: [{ role: "user", content: "probe" }] };
    assert.deepEqual(await runner.emitBeforeProviderRequest(payload), payload);
    const headers = await runner.emitBeforeProviderHeaders({});
    assert.ok(headers["x-codex-beta-features"]);
    await session.prompt("/fast status");
    await session.prompt("/context");
    await session.prompt("/skills __missing_skill__");
    await session.prompt("/diff hide");
    await session.prompt("/view __missing_file__");
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "agent_end", messages: [] });
    await runner.emit({ type: "agent_settled", outcome: "completed" } as any);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(errors, [], JSON.stringify(errors));
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
