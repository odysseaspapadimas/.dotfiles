import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "pi-core-test-"));
  const agentDir = join(root, "agent");
  const socketPath = join(root, "core.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_HERDR_SIDE_SHARED_AGENT_DIR;
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_WORKSPACE_ID;
  process.env.HC_TERMINAL_ID = "t1";
  process.env.HC_TERMINAL_SOCKET = socketPath;
  process.env.PI_SESSIONS_PROMPT_ACCEPT_TIMEOUT_MS = "100";

  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { default: orchestrator } = await import("../pi-session-orchestrator.ts");
  const { sessionBackend, corePane, coreRequest, CoreSessions } = await import("../pi-sessions/core.ts");
  const { SessionMailbox, sendMailbox, renameMailbox } = await import("../pi-sessions/mailbox.ts");
  const { REPORT_TYPE, SETTLED_TYPE } = await import("../pi-sessions/store.ts");
  const { Value } = await import("typebox/value");
  type Terminal = import("../pi-sessions/core.ts").CoreTerminal;

  assert.equal(sessionBackend({}), "none");
  assert.equal(sessionBackend({ HC_TERMINAL_ID: "t1" }), "none");
  assert.equal(sessionBackend({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath }), "core");
  assert.equal(sessionBackend({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath }), "tui");

  const terminals = new Map<string, Terminal>();
  const receivers = new Map<string, InstanceType<typeof SessionMailbox>>();
  const calls: { method: string; params: any }[] = [];
  const appCalls: string[][] = [];
  const events = new Map<string, (...args: any[]) => any>();
  const sockets = new Set<Socket>();
  let registered: any;
  let nextTerminal = 2;
  let acceptInitial = true;
  let failKill = false;
  let appAvailable = true;
  let delivered = 0;
  let reports = 0;
  const drafts = new Map<string, string>();

  function exchange(path: string, prompt: string) {
    const manager = SessionManager.open(path);
    const userEntryId = manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    const assistantEntryId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply: ${prompt}` }],
      api: "openai-responses", provider: "test", model: "model", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.appendCustomEntry(SETTLED_TYPE, { sessionId: manager.getSessionId(), userEntryId, assistantEntryId, outcome: "completed" });
  }

  async function receiver(terminal: Terminal, path: string) {
    await receivers.get(terminal.address)?.close();
    const mailbox = new SessionMailbox(join(agentDir, "pi-sessions-ipc"), {
      sessionId: SessionManager.open(path).getSessionId(), sessionPath: path, paneId: terminal.address,
    }, {
      isCurrent: () => terminals.get(terminal.address) === terminal && corePane(terminal)?.agent_session?.value === path,
      isIdle: () => ["idle", "done"].includes(terminal.status?.state ?? ""),
      hasPendingMessages: () => false,
      rename: (name) => SessionManager.open(path).appendSessionInfo(name),
      deliver: (content, action) => {
        if (action === "report") { reports++; SessionManager.open(path).appendCustomMessageEntry(REPORT_TYPE, content, true); }
        else { delivered++; exchange(path, content); terminal.status = { app: "pi", state: "done" }; }
      },
      findAccepted: (id) => {
        for (const entry of SessionManager.open(path).getBranch()) {
          const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content :
            entry.type === "custom_message" && entry.customType === REPORT_TYPE ? entry.content : undefined;
          if (typeof content === "string" && content.startsWith(`[pi_sessions:${id}]\n`)) {
            return { entryId: entry.id, content, action: entry.type === "message" ? "send" : "report" };
          }
        }
      },
      onError: (error) => { throw error; },
    });
    await mailbox.start();
    receivers.set(terminal.address, mailbox);
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const { method, params } = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      calls.push({ method, params });
      void (async () => {
        let result: any;
        try {
          if (method === "test.hang") return;
          if (method === "test.bad-id") { socket.end('{"jsonrpc":"2.0","id":2,"result":{}}\n'); return; }
          if (method === "terminal.list") result = { terminals: [...terminals.values()] };
          else if (method === "terminal.get") {
            result = terminals.get(params.terminal);
            if (!result) throw new Error("not_found");
          } else if (method === "terminal.label") {
            const terminal = terminals.get(params.terminal)!;
            for (const [key, value] of Object.entries(params.labels)) {
              if (value === "") delete terminal.labels[key]; else terminal.labels[key] = value as string;
            }
            result = terminal;
          } else if (method === "terminal.run") {
            const address = `t${nextTerminal++}`;
            const terminal: Terminal = { address, argv: params.argv, cwd: params.cwd, state: "live", labels: { ...params.labels },
              foreground: { argv: ["pi"], cwd: params.cwd, pid: 10_000 + nextTerminal }, status: { app: "pi", state: "idle" } };
            terminals.set(address, terminal);
            const path = params.argv[params.argv.indexOf("--session") + 1];
            await receiver(terminal, path);
            const prompt = params.argv.at(-1);
            if (prompt.startsWith("\n") && acceptInitial) exchange(path, prompt.trim());
            acceptInitial = true;
            result = terminal;
          } else if (method === "terminal.kill") {
            if (failKill) throw new Error("cleanup unavailable");
            await receivers.get(params.terminal)?.close();
            terminals.get(params.terminal)!.state = "finished";
            result = terminals.get(params.terminal);
          } else throw new Error(`Unexpected method ${method}`);
          const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`;
          // Exercise fragmented replies, not just one data event per response.
          socket.write(frame.slice(0, 15));
          socket.end(frame.slice(15));
        } catch (error) { socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: String(error) } })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  async function fixture(name: string) {
    const manager = SessionManager.create(root, join(agentDir, "sessions", "fixture"));
    manager.appendSessionInfo(name);
    const path = manager.getSessionFile()!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    exchange(path, "existing conversation");
    return SessionManager.open(path);
  }

  try {
    const parent = await fixture("Parent");
    terminals.set("t1", { address: "t1", argv: ["fish"], cwd: root, state: "live", labels: { "herdr.space": "sp-parent", "herdr.tab": "tb-parent" },
      foreground: { argv: ["pi"], cwd: root, pid: process.pid }, status: { app: "pi", state: "working" } });
    const ctx: any = { mode: "tui", hasUI: false, cwd: root, model: { provider: "test-provider", id: "test-model" },
      sessionManager: parent, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } };
    orchestrator({ on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler), registerTool: (tool: any) => { registered = tool; },
      registerCommand() {}, getThinkingLevel: () => "medium", setSessionName: (name: string) => ctx.sessionManager.appendSessionInfo(name),
      exec: async (command: string, args: string[]) => {
        assert.ok(command === "herdr-app" || command.endsWith("/.local/bin/herdr-ui"),
          "core focus uses the installed bridge or the local app, never old herdr or terminal input");
        appCalls.push(args);
        return appAvailable ? { code: 0, stdout: "{}", stderr: "", killed: false } : { code: 1, stdout: "", stderr: "No running window", killed: false };
      },
    } as any);
    await events.get("session_start")!({}, ctx);
    const execute = async (params: any) => {
      const result = await registered.execute("test", params, undefined, undefined, ctx);
      assert.ok(Value.Check(registered.outputSchema, result.structuredContent), `Invalid ${params.action} result`);
      return result.structuredContent;
    };
    let result = await execute({ action: "status", id: "self" });
    assert.equal(result.status, "working", "plain pi without --session is registered by its own process");
    assert.equal(result.runtimes[0].pane_id, "t1");
    await assert.rejects(execute({ action: "stop", id: "self" }), /current Pi session/);

    await assert.rejects(coreRequest(socketPath, "test.bad-id", {}), /Invalid core acknowledgment/);
    await assert.rejects(coreRequest(socketPath, "test.hang", {}, AbortSignal.timeout(20)), /abort|timeout/i);
    await assert.rejects(coreRequest(socketPath, "unknown", {}), /Unexpected method/);

    result = await execute({ action: "create", name: "A worker with spaces & symbols!", message: "@file -literal 'quotes'", lifecycle: "persistent" });
    const worker = result.session;
    const address = result.runtime.pane_id;
    const terminal = terminals.get(address)!;
    const launch = calls.findLast((call) => call.method === "terminal.run")!.params;
    assert.equal(result.startingMessageAccepted, true);
    assert.equal(worker.parentSessionId, parent.getSessionId());
    assert.equal(launch.parent, "t1");
    assert.equal(launch.no_notify, true);
    assert.equal(launch.outlive_parent, true);
    assert.equal(launch.labels["herdr.space"], "sp-parent");
    assert.notEqual(launch.labels["herdr.tab"], "tb-parent");
    assert.match(launch.name, /^[a-z0-9_-]{1,32}$/);
    assert.equal(launch.argv.at(-1), "\n@file -literal 'quotes'");
    assert.equal(launch.argv.includes("--print"), false);
    drafts.set(address, "unfinished draft");

    // Neither a remote machine with the same path nor a stale process label owns a local session.
    terminals.set("debina/t9", { ...terminal, address: "debina/t9" });
    const stale = { ...terminal, address: "tstale", foreground: { argv: ["fish"], cwd: root, pid: 42 },
      labels: { ...terminal.labels, "pi-sessions.pid": "41" } };
    assert.equal(corePane(stale)?.agent_session, undefined);
    assert.equal(corePane({ ...stale, foreground: { argv: ["pi"], pid: 42 } })?.agent_session, undefined,
      "a different Pi process must not inherit the old PID's launch identity");
    assert.equal(corePane({ ...terminal, foreground: { argv: ["pi"], pid: 99 } })?.agent_session?.value, worker.sessionPath,
      "compact foreground titles still resolve launch argv before registration");
    terminals.set(stale.address, stale);
    result = await execute({ action: "status", id: worker.id });
    assert.equal(result.runtimes.length, 1);
    result = await execute({ action: "status", id: address });
    assert.equal(result.session.id, worker.id, "core terminal addresses resolve like old pane IDs");

    const launchesBeforeMissingMailbox = calls.filter((call) => call.method === "terminal.run").length;
    await receivers.get(address)!.close();
    await assert.rejects(execute({ action: "send", id: worker.id, message: "missing receiver" }), /Reload the TARGET session/);
    assert.equal(calls.filter((call) => call.method === "terminal.run").length, launchesBeforeMissingMailbox);
    await receiver(terminal, worker.sessionPath);
    result = await execute({ action: "send", id: worker.id, message: "follow-up" });
    const messageId = result.messageId;
    assert.equal(result.messageAccepted, true);
    await execute({ action: "send", id: worker.id, message: "follow-up", messageId });
    assert.equal(delivered, 1);
    result = await execute({ action: "watch", id: worker.id, messageId, timeoutSeconds: 1 });
    assert.equal(result.outcome, "completed");
    assert.match(result.latest.text, /follow-up/);
    await execute({ action: "report", id: worker.id, message: "informational update" });
    assert.equal(reports, 1);
    assert.equal(delivered, 1);
    await execute({ action: "rename", id: worker.id, name: "Renamed safely" });
    assert.equal(SessionManager.open(worker.sessionPath).getSessionName(), "Renamed safely");
    assert.equal(drafts.get(address), "unfinished draft");

    terminal.status = { app: "pi", state: "working" };
    await assert.rejects(execute({ action: "rename", id: worker.id, name: "busy" }), /Cannot rename/);
    await assert.rejects(renameMailbox(join(agentDir, "pi-sessions-ipc"), {
      sessionId: worker.sessionId, sessionPath: worker.sessionPath, paneId: address,
    }, "busy"), /Cannot rename/);
    result = await execute({ action: "send", id: worker.id, message: "queued follow-up" });
    const queuedId = result.messageId;
    assert.equal(result.delivery.state, "queued");
    result = await execute({ action: "watch", id: worker.id, messageId: queuedId, timeoutSeconds: 1 });
    assert.equal(result.timedOut, true);
    terminal.status = { app: "pi", state: "idle" };
    receivers.get(address)!.wake();
    result = await execute({ action: "watch", id: worker.id, messageId: queuedId, timeoutSeconds: 1 });
    assert.equal(result.outcome, "completed");
    assert.match(result.latest.text, /queued follow-up/);

    terminals.set("tduplicate", { ...terminal, address: "tduplicate" });
    await assert.rejects(execute({ action: "send", id: worker.id, message: "ambiguous" }), /multiple Herdr panes/);
    terminals.delete("tduplicate");
    await execute({ action: "focus", id: worker.id });
    assert.deepEqual(appCalls.at(-1), ["do", "pane.focus", JSON.stringify({ terminal: address })]);
    const partialFocus = new CoreSessions(socketPath, "t1", async () => ({ code: 0, stderr: "",
      stdout: JSON.stringify({ ok: true, _routing: { view_errors: { windows: "window closed" } } }) }));
    await assert.rejects(() => partialFocus.focus({ pane_id: address }), /mirroring was incomplete/);
    appAvailable = false;
    await assert.rejects(execute({ action: "focus", id: worker.id }), /session remains running/);
    appAvailable = true;

    // Safe cleanup always kills only the exact associated terminal, not other tab contents.
    const sibling: Terminal = { address: "tsibling", argv: ["fish"], cwd: root, state: "live", labels: { ...terminal.labels },
      foreground: { argv: ["fish"], pid: 91 } };
    terminals.set(sibling.address, sibling);
    await execute({ action: "stop", id: worker.id });
    assert.equal(terminal.state, "finished");
    assert.equal(sibling.state, "live");
    assert.equal(terminals.get("debina/t9")!.state, "live");
    assert.equal(appCalls.some((args) => args.includes("tab.close")), false);
    const usersBefore = SessionManager.open(worker.sessionPath).getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length;
    result = await execute({ action: "resume", id: worker.id });
    assert.equal(SessionManager.open(worker.sessionPath).getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, usersBefore);
    await execute({ action: "stop", id: worker.id });

    acceptInitial = false;
    await assert.rejects(execute({ action: "create", name: "Rejected startup", message: "not accepted" }), /PI_SESSIONS_CREATE_INCOMPLETE/);
    assert.equal([...terminals.values()].filter((t) => t.state === "live" && t.address.startsWith("t") &&
      t.labels["pi-sessions.path"] && t.address !== "tstale" && t.address !== "tsibling" && t.address !== "t1").length, 0);

    failKill = true;
    const failedCleanup = (await execute({ action: "create", name: "Cleanup failure", message: "done", lifecycle: "task" })).session;
    result = await execute({ action: "watch", id: failedCleanup.id, timeoutSeconds: 1 });
    assert.equal(result.outcome, "completed");
    assert.equal(result.cleanedUp, false);
    assert.match(result.cleanupError, /cleanup unavailable/);
    failKill = false;
    await execute({ action: "stop", id: failedCleanup.id });
    const task = (await execute({ action: "create", name: "Task worker", message: "one task", lifecycle: "task" })).session;
    result = await execute({ action: "watch", id: task.id, timeoutSeconds: 2 });
    assert.equal(result.outcome, "completed");
    assert.equal((await execute({ action: "status", id: task.id })).status, "stopped");
    assert.ok((await readFile(task.sessionPath, "utf8")).includes("one task"));

    // A plain hc terminal needs no app window, workspace document, or tab labels.
    const parentLabels = terminals.get("t1")!.labels;
    delete parentLabels["herdr.space"];
    delete parentLabels["herdr.tab"];
    const headless = await execute({ action: "create", name: "Core only", message: "no window needed" });
    assert.equal(headless.runtime.tab_id, undefined);
    assert.match(headless.output, /core terminal/);
    await execute({ action: "stop", id: headless.session.id });
    const reopenedHeadless = await execute({ action: "resume", id: headless.session.id });
    assert.doesNotMatch(reopenedHeadless.output, /undefined/);
    await execute({ action: "stop", id: headless.session.id });

    // A session switch re-registers the same process; stale mailbox identities cannot target it.
    const replacement = await fixture("Replacement");
    ctx.sessionManager = replacement;
    await events.get("session_start")!({}, ctx);
    assert.equal((await execute({ action: "status", id: parent.getSessionFile() })).status, "stopped");
    assert.equal((await execute({ action: "status", id: "self" })).session.sessionId, replacement.getSessionId());
    await assert.rejects(sendMailbox(join(agentDir, "pi-sessions-ipc"), {
      sessionId: parent.getSessionId(), sessionPath: parent.getSessionFile()!, paneId: "t1",
    }, "stale target"), /Reload the TARGET session|Mailbox target changed/);
    const core = new CoreSessions(socketPath, "t1", async () => ({ code: 0, stdout: "{}", stderr: "" }));
    await assert.rejects(core.stop({ pane_id: "t1" }, parent.getSessionFile()!), /changed sessions/);
    console.log("pi_sessions app/core lifecycle, scope, messaging, and cleanup tests passed");
  } finally {
    await events.get("session_shutdown")?.({});
    await Promise.all([...receivers.values()].map((mailbox) => mailbox.close()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
