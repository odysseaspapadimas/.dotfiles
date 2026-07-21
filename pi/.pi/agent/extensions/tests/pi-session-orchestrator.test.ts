import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-session-orchestrator-test-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "w-test";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { default: orchestrator } = await import("../pi-session-orchestrator.ts");

interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent?: string;
  agent_status?: string;
  agent_session?: { kind: string; value: string };
}

const panes = new Map<string, Pane>();
let registered: any;
let nextRuntime = 1;

function output(result: unknown = {}) {
  return { code: 0, stdout: `${JSON.stringify({ result })}\n`, stderr: "", killed: false };
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function appendExchange(path: string, prompt: string): void {
  const manager = SessionManager.open(path);
  manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `reply: ${prompt}` }],
    provider: "test",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

const fakePi: any = {
  registerTool(definition: any) {
    registered = definition;
  },
  getThinkingLevel() {
    return "medium";
  },
  async exec(command: string, args: string[]) {
    assert.equal(command, "herdr");
    if (args[0] === "api" && args[1] === "snapshot") return output({ snapshot: { panes: [...panes.values()] } });
    if (args[0] === "pane" && args[1] === "process-info") return output({ process_info: { pane_id: args[3], foreground_processes: [] } });
    if (args[0] === "tab" && args[1] === "create") {
      const number = nextRuntime++;
      const tabId = `w-test:t${number}`;
      const paneId = `w-test:p${number}`;
      panes.set(paneId, { pane_id: paneId, tab_id: tabId, workspace_id: "w-test", agent_status: "unknown" });
      return output({ tab: { tab_id: tabId }, root_pane: { pane_id: paneId } });
    }
    if (args[0] === "pane" && args[1] === "run") {
      const pane = panes.get(args[2]);
      assert.ok(pane);
      const text = args[3];
      if (text.startsWith("pi --session ")) {
        const match = text.match(/--session '([^']+)'/);
        assert.ok(match);
        const hasAssistant = SessionManager.open(match[1]).getBranch().some(
          (entry: any) => entry.type === "message" && entry.message.role === "assistant",
        );
        assert.match(text, hasAssistant ? /--provider 'test'/ : /--provider 'test-provider'/);
        assert.match(text, hasAssistant ? /--model 'model'/ : /--model 'test-model'/);
        assert.match(text, /--thinking 'medium'/);
        pane.agent = "pi";
        pane.agent_status = "idle";
        pane.agent_session = { kind: "path", value: match[1] };
      } else if (text.startsWith("/name ")) {
        SessionManager.open(pane.agent_session!.value).appendSessionInfo(text.slice(6));
      } else {
        pane.agent_status = "working";
        appendExchange(pane.agent_session!.value, text);
        pane.agent_status = "idle";
      }
      return output({});
    }
    if (args[0] === "pane" && args[1] === "get") return output({ pane: panes.get(args[2]) });
    if (args[0] === "pane" && args[1] === "send-keys") return output({});
    if (args[0] === "pane" && args[1] === "close") {
      panes.delete(args[2]);
      return output({});
    }
    if (args[0] === "tab" && args[1] === "close") {
      for (const [id, pane] of panes) if (pane.tab_id === args[2]) panes.delete(id);
      return output({});
    }
    if (args[0] === "tab" && (args[1] === "focus" || args[1] === "rename")) return output({});
    throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
  },
};

function execute(params: Record<string, unknown>) {
  return registered.execute("test-call", params, undefined, undefined, {
    cwd: root,
    model: { provider: "test-provider", id: "test-model" },
  });
}

try {
  // One-time compatibility migration: preserve a real legacy session and discard the index.
  const legacy = SessionManager.create(root);
  legacy.appendSessionInfo("Legacy");
  const legacyPath = legacy.getSessionFile()!;
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, `${[legacy.getHeader(), ...legacy.getEntries()].map(JSON.stringify).join("\n")}\n`);
  const registryPath = join(agentDir, "pi-session-orchestrator", "registry.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({ version: 1, sessions: { dir_legacy: { id: "dir_legacy", name: "Legacy", sessionPath: legacyPath, createdAt: Date.now(), provider: "test-provider", model: "test-model", thinking: "medium" } } }));

  orchestrator(fakePi);
  assert.equal(registered.name, "pi_sessions");
  let result = await execute({ action: "list" });
  assert.match(result.content[0].text, /dir_legacy/);
  await assert.rejects(readFile(registryPath), /ENOENT/);
  assert.ok(SessionManager.open(legacyPath).getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "pi-session-orchestrator"));

  result = await execute({ action: "create", name: "Lifecycle", message: "start", cwd: root });
  const created = result.details.session;
  assert.match(created.id, /^dir_[0-9a-f]{32}$/);
  assert.equal(created.name, "Lifecycle");
  assert.match(result.content[0].text, /Starting message sent/);

  result = await execute({ action: "list" });
  assert.match(result.content[0].text, /Lifecycle/);
  assert.match(result.content[0].text, /idle/);

  const prefix = created.id.slice(0, 12);
  result = await execute({ action: "status", id: prefix });
  assert.match(result.content[0].text, /Status: idle/);
  await assert.rejects(execute({ action: "status", id: "dir_" }), /Ambiguous session ID prefix/);
  assert.match(result.content[0].text, /reply: start/);

  result = await execute({ action: "read", id: "Lifecycle", limit: 10 });
  assert.match(result.content[0].text, /User: start/);
  assert.match(result.content[0].text, /Assistant: reply: start/);

  result = await execute({ action: "watch", id: created.id, timeoutSeconds: 1 });
  assert.match(result.content[0].text, /Completed/);

  result = await execute({ action: "send", id: created.id, message: "follow up" });
  assert.match(result.content[0].text, /Sent follow-up/);
  result = await execute({ action: "read", id: created.id });
  assert.match(result.content[0].text, /reply: follow up/);

  await execute({ action: "rename", id: created.id, name: "Renamed" });
  result = await execute({ action: "status", id: "Renamed" });
  assert.match(result.content[0].text, /\(Renamed\)/);

  SessionManager.open(created.sessionPath).appendSessionInfo("Manual name");
  result = await execute({ action: "status", id: "Manual name" });
  assert.match(result.content[0].text, /\(Manual name\)/);

  // Forks copy custom entries, but bound metadata prevents duplicate records.
  const fork = SessionManager.forkFrom(created.sessionPath, root);
  const forkPath = fork.getSessionFile()!;
  result = await execute({ action: "list" });
  assert.equal((result.content[0].text.match(new RegExp(created.id, "g")) ?? []).length, 1);
  await unlink(forkPath);

  // Pane movement changes only live Herdr fields; path metadata keeps association fresh.
  const live = [...panes.values()].find((pane) => pane.agent_session?.value === created.sessionPath)!;
  live.tab_id = "w-test:moved-tab";
  live.workspace_id = "w-other";
  result = await execute({ action: "focus", id: created.id });
  assert.match(result.content[0].text, /Focused/);

  await execute({ action: "stop", id: created.id });
  result = await execute({ action: "status", id: created.id });
  assert.match(result.content[0].text, /Status: stopped/);

  result = await execute({ action: "resume", id: created.id });
  assert.match(result.content[0].text, /Running/);

  // Manual tab closure disappears from the live snapshot without leaving stale state.
  let resumedPane = [...panes.values()].find((pane) => pane.agent_session?.value === created.sessionPath)!;
  panes.delete(resumedPane.pane_id);
  result = await execute({ action: "status", id: created.id });
  assert.match(result.content[0].text, /Status: stopped/);
  await execute({ action: "resume", id: created.id });

  // A manual /resume updates native Herdr metadata, so the old session is no longer live.
  resumedPane = [...panes.values()].find((pane) => pane.agent_session?.value === created.sessionPath)!;
  resumedPane.agent_session = { kind: "path", value: legacyPath };
  result = await execute({ action: "status", id: created.id });
  assert.match(result.content[0].text, /Status: stopped/);
  resumedPane.agent_session = { kind: "path", value: created.sessionPath };

  // Session-file deletion naturally removes the durable record.
  await execute({ action: "stop", id: created.id });
  await unlink(created.sessionPath);
  result = await execute({ action: "list" });
  assert.doesNotMatch(result.content[0].text, /Manual name/);

  console.log("pi-session-orchestrator lifecycle tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
