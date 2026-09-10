import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function main() {
const root = await mkdtemp(join(tmpdir(), "pi-session-orchestrator-test-"));
const agentDir = join(root, "agent");
const sideAgentDir = join(agentDir, "herdr-side-chat", "runtime");
process.env.PI_CODING_AGENT_DIR = sideAgentDir;
process.env.PI_HERDR_SIDE_SHARED_AGENT_DIR = agentDir;
process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "w-test";
process.env.PI_SESSIONS_PROMPT_ACCEPT_TIMEOUT_MS = "100";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { default: orchestrator, parseModelOverride, sideSharedAgentDirectory } = await import("../pi-session-orchestrator.ts");
const { SessionStore, textContent } = await import("../pi-sessions/store.ts");
const { SessionMailbox, mailboxPending, sendMailbox } = await import("../pi-sessions/mailbox.ts");
const { recall, conversationPage } = await import("../pi-sessions/recall.ts");
const { runState } = await import("../pi-sessions/runs.ts");

assert.deepEqual(parseModelOverride("openai-codex/gpt-5.6-luna"), {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
});
assert.throws(() => parseModelOverride("gpt-5.6-luna"), /provider\/model format/);
assert.throws(() => parseModelOverride("openai-codex/"), /provider\/model format/);
assert.equal(sideSharedAgentDirectory(sideAgentDir, agentDir), agentDir);
assert.equal(sideSharedAgentDirectory(sideAgentDir, undefined), agentDir);
assert.equal(sideSharedAgentDirectory(agentDir, undefined), undefined);

interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent?: string;
  agent_status?: string;
  agent_session?: { kind: string; value: string };
}

const panes = new Map<string, Pane>();
const receivers = new Map<string, InstanceType<typeof SessionMailbox>>();
const drafts = new Map<string, string>();
let mailboxDeliveries = 0;

async function startReceiver(path: string, pane: Pane) {
  await receivers.get(pane.pane_id)?.close();
  const sessionId = SessionManager.open(path).getSessionId();
  const receiver = new SessionMailbox(join(agentDir, "pi-sessions-ipc"), { sessionId, sessionPath: path, paneId: pane.pane_id }, {
    isCurrent: () => panes.get(pane.pane_id) === pane && pane.agent_session?.value === path,
    isIdle: () => pane.agent_status === "idle" || pane.agent_status === "done",
    hasPendingMessages: () => false,
    findAccepted: (messageId) => {
      for (const entry of SessionManager.open(path).getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const content = textContent(entry.message.content);
        if (content.startsWith(`[pi_sessions:${messageId}]\n`)) return { entryId: entry.id, content };
      }
    },
    deliver: (content) => {
      mailboxDeliveries++;
      pane.agent_status = "working";
      appendExchange(path, content);
      pane.agent_status = "idle";
    },
    onError: (error) => { throw error; },
  });
  await receiver.start();
  receivers.set(pane.pane_id, receiver);
}
let registered: any;
const eventHandlers = new Map<string, (...args: any[]) => unknown>();
let nextRuntime = 1;
let acceptNextInitialPrompt = true;
let failTabClose = false;
const herdrCalls: string[][] = [];
let settlingPath: string | undefined;

function settle(path: string) {
  settlingPath = path;
  eventHandlers.get("agent_settled")?.({}, { sessionManager: SessionManager.open(path), isIdle: () => true });
  settlingPath = undefined;
}

function output(result: unknown = {}) {
  return { code: 0, stdout: `${JSON.stringify({ result })}\n`, stderr: "", killed: false };
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function shellArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let started = false;
  for (const char of command) {
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
    } else if (char === '"') {
      quote = "double";
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function initialPrompt(command: string): string | undefined {
  const args = shellArgs(command);
  const optionsWithValues = new Set(["--session", "--provider", "--model", "--thinking"]);
  const positional: string[] = [];
  for (let index = 1; index < args.length; index++) {
    if (optionsWithValues.has(args[index])) {
      index++;
      continue;
    }
    positional.push(args[index]);
  }
  return positional[0]?.trim() || undefined;
}

function appendExchange(path: string, prompt: string): void {
  const manager = SessionManager.open(path);
  manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `reply: ${prompt.replace(/^\[pi_sessions:[^\]]+\]\n/u, "")}` }],
    provider: "test",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

const fakePi: any = {
  on(name: string, handler: (...args: any[]) => unknown) {
    eventHandlers.set(name, handler);
  },
  registerTool(definition: any) {
    registered = definition;
  },
  getThinkingLevel() {
    return "medium";
  },
  appendEntry(type: string, data: unknown) {
    assert.ok(settlingPath);
    SessionManager.open(settlingPath).appendCustomEntry(type, data);
  },
  async exec(command: string, args: string[]) {
    assert.equal(command, "herdr");
    herdrCalls.push([...args]);
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
        const metadata = SessionManager.open(match[1]).getEntries().findLast(
          (entry: any) => entry.type === "custom" && entry.customType === "pi-session-orchestrator",
        )?.data;
        assert.match(text, new RegExp(`--provider '${hasAssistant ? "test" : metadata.initialProvider}'`));
        assert.match(text, new RegExp(`--model '${hasAssistant ? "model" : metadata.initialModel}'`));
        const metadataForThinking = SessionManager.open(match[1]).getEntries().findLast(
          (entry: any) => entry.type === "custom" && entry.customType === "pi-session-orchestrator",
        )?.data;
        assert.match(text, new RegExp(`--thinking '${metadataForThinking?.initialThinking ?? "medium"}'`));
        pane.agent = "pi";
        pane.agent_status = "idle";
        pane.agent_session = { kind: "path", value: match[1] };
        await startReceiver(match[1], pane);
        const prompt = initialPrompt(text);
        if (prompt) {
          const accepted = acceptNextInitialPrompt;
          acceptNextInitialPrompt = true;
          if (accepted) {
            pane.agent_status = "working";
            appendExchange(match[1], prompt);
            pane.agent_status = "idle";
          }
        }
      } else if (text.startsWith("/name ")) {
        SessionManager.open(pane.agent_session!.value).appendSessionInfo(text.slice(6));
      } else {
        throw new Error("Follow-ups must use the mailbox, never pane run / terminal input");
      }
      return output({});
    }
    if (args[0] === "pane" && args[1] === "get") return output({ pane: panes.get(args[2]) });
    if (args[0] === "pane" && args[1] === "close") {
      await receivers.get(args[2])?.close();
      panes.delete(args[2]);
      return output({});
    }
    if (args[0] === "tab" && args[1] === "close") {
      if (failTabClose) return { code: 1, stdout: "", stderr: "cleanup unavailable", killed: false };
      for (const [id, pane] of panes) if (pane.tab_id === args[2]) {
        await receivers.get(id)?.close();
        panes.delete(id);
      }
      return output({});
    }
    if (args[0] === "tab" && (args[1] === "focus" || args[1] === "rename")) return output({});
    throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
  },
};

function execute(params: Record<string, unknown>, sessionManager?: InstanceType<typeof SessionManager>) {
  return registered.execute("test-call", params, undefined, undefined, {
    cwd: root,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager,
  });
}

try {
  // One-time compatibility migration: preserve a real legacy session and discard the index.
  const legacy = SessionManager.create(root, join(agentDir, "sessions", "fixture-project"));
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

  // Ordinary Pi sessions are retained as historical records, then classified as discovered when active.
  const external = SessionManager.create(root, join(agentDir, "sessions", "fixture-project"));
  external.appendSessionInfo("External review");
  const externalPath = external.getSessionFile()!;
  await mkdir(dirname(externalPath), { recursive: true });
  await writeFile(externalPath, `${[external.getHeader(), ...external.getEntries()].map(JSON.stringify).join("\n")}\n`);
  appendExchange(externalPath, "ordinary session");

  // Recall is local, dated, ranked and directly readable; it does not need a runtime.
  const history = new SessionStore(join(agentDir, "sessions"));
  const first = await history.load(externalPath);
  assert.equal(await history.load(externalPath), first, "unchanged transcripts reuse their projection");
  appendExchange(externalPath, "implemented piSession recall with cursor paging; next: investigate timeouts");
  appendExchange(legacyPath, "cursor ".repeat(50)); // Repetition must lose to broader topic coverage.
  assert.notEqual(await history.load(externalPath), first, "appends invalidate cached projections");
  const callCount = herdrCalls.length;
  result = await execute({ action: "recall", query: "pi_session cursor", cwd: root });
  assert.equal(result.details.hits[0].session.sessionId, external.getSessionId());
  assert.deepEqual(result.details.hits[0].matchedTerms.sort(), ["cursor", "pi", "session"]);
  const evidence = result.details.hits[0].evidence[0];
  result = await execute({ action: "read", id: externalPath, cursor: evidence.entryId, limit: 1 });
  assert.match(result.content[0].text, /piSession recall/);
  assert.equal(herdrCalls.length, callCount, "recall and path reads must not call Herdr");
  const date = (await history.load(externalPath)).messages[0].timestamp;
  const excluded = await recall(history, { query: "ordinary", before: date, limit: 10, offset: 0 });
  assert.equal(excluded.total, 0, "recall bounds filter message dates, even when the file was just modified");
  result = await execute({ action: "recall", after: "1d" });
  assert.ok(result.details.hits.some((hit: any) => hit.session.sessionId === external.getSessionId()));
  result = await execute({ action: "list", limit: 1 });
  assert.equal(result.details.sessions.length, 1);
  assert.equal(result.details.nextOffset, 1);

  // A huge single message remains completely readable through character/line-bounded cursors.
  const snapshot = await history.load(externalPath);
  const huge = "🙂a\n".repeat(5000);
  const oversized = { ...snapshot, messages: [{ id: "huge", role: "assistant" as const, timestamp: date, text: huge }] };
  let cursor: string | undefined = "huge";
  let restored = "";
  do {
    const page = conversationPage(oversized, 1, cursor);
    assert.ok(Buffer.byteLength(page.text) < 32 * 1024);
    assert.ok(page.text.split("\n").length < 1000);
    restored += page.text.slice(page.text.indexOf("\n") + "\nAssistant: ".length);
    assert.notEqual(page.nextCursor, cursor, "pagination must make progress");
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(restored, huge);
  assert.throws(() => conversationPage(oversized, 1, "missing"), /Unknown read cursor/);
  const toolUse = { ...snapshot, settled: [], messages: snapshot.messages.map((entry) =>
    entry.role === "assistant" ? { ...entry, stopReason: "toolUse" } : entry) };
  assert.equal(runState(toolUse, "idle").outcome, undefined, "tool-use commentary is not completion");
  const failed = { ...toolUse, messages: toolUse.messages.map((entry) => entry.role === "assistant" ? { ...entry, stopReason: "length" } : entry) };
  assert.equal(runState(failed, "idle").outcome, "failed", "token-limit exits must not trigger successful task cleanup");

  result = await execute({ action: "list" });
  assert.match(result.content[0].text, new RegExp(`${external.getSessionId()}\\s+historical\\s+stopped`));
  result = await execute({ action: "list", cwd: root, updatedAfter: "1d" });
  assert.match(result.content[0].text, /External review/);
  result = await execute({ action: "list", createdAfter: "2999-01-01T00:00:00Z" });
  assert.match(result.content[0].text, /No local Pi sessions matched/);
  await assert.rejects(execute({ action: "list", createdAfter: "sometime recently" }), /must be an ISO date/);
  result = await execute({ action: "read", id: "External review" });
  assert.match(result.content[0].text, /ordinary session/);

  panes.set("w-test:external", {
    pane_id: "w-test:external",
    tab_id: "w-test:external-tab",
    workspace_id: "w-test",
    agent: "pi",
    agent_status: "idle",
    agent_session: { kind: "path", value: externalPath },
  });
  result = await execute({ action: "status", id: "w-test:external" });
  assert.match(result.content[0].text, /Origin: discovered/);
  await assert.rejects(
    execute({ action: "send", id: external.getSessionId(), message: "unsafe draft overwrite" }),
    /Reload the TARGET session/,
  );
  const externalPane = panes.get("w-test:external")!;
  drafts.set(externalPane.pane_id, "unfinished user draft — leave this alone");
  await startReceiver(externalPath, externalPane);
  result = await execute({ action: "send", id: externalPath, message: "safe discovered follow-up" });
  assert.equal(result.details.messageAccepted, true);
  const acceptedId = result.details.messageId;
  const countAfterAccepted = mailboxDeliveries;
  result = await execute({ action: "send", id: externalPath, message: "safe discovered follow-up", messageId: acceptedId });
  assert.equal(result.details.delivery.state, "accepted");
  assert.equal(mailboxDeliveries, countAfterAccepted, "retrying the same ID must not inject twice");
  await assert.rejects(execute({ action: "send", id: externalPath, message: "different", messageId: acceptedId }), /different message/);

  externalPane.agent_status = "working";
  result = await execute({ action: "send", id: externalPath, message: "queued behind current run" });
  assert.equal(result.details.messageAccepted, false);
  assert.equal(result.details.delivery.state, "queued");
  const queuedId = result.details.messageId;
  result = await execute({ action: "send", id: externalPath, message: "queued behind current run", messageId: queuedId });
  assert.equal(result.details.delivery.state, "queued", "a queued retry must not add a second request");
  assert.equal(await mailboxPending(join(agentDir, "pi-sessions-ipc"), {
    sessionId: external.getSessionId(), sessionPath: externalPath, paneId: externalPane.pane_id,
  }), true, "queued messages must prevent automatic task cleanup");
  result = await execute({ action: "status", id: externalPath, messageId: queuedId });
  assert.equal(result.details.delivery.state, "queued");
  assert.equal(result.details.outcome, undefined, "status must not report the previous run as this request's outcome");
  result = await execute({ action: "watch", id: externalPath, messageId: queuedId, timeoutSeconds: 1 });
  assert.equal(result.details.timedOut, true, "watch must not mistake the preceding run for this queued request");
  assert.equal(mailboxDeliveries, countAfterAccepted);
  externalPane.agent_status = "idle";
  receivers.get(externalPane.pane_id)!.wake();
  result = await execute({ action: "watch", id: externalPath, messageId: queuedId, timeoutSeconds: 1 });
  assert.equal(result.details.outcome, "completed");
  assert.match(result.details.latest.text, /queued behind current run/);
  assert.equal(drafts.get(externalPane.pane_id), "unfinished user draft — leave this alone");

  externalPane.agent_status = "working";
  const staleId = (await execute({ action: "send", id: externalPath, message: "do not replay across reload" })).details.messageId;
  await startReceiver(externalPath, externalPane); // New runtime generation, same session and pane.
  await assert.rejects(execute({ action: "send", id: externalPath, message: "do not replay across reload", messageId: staleId }), /receiver restarted or changed/);
  externalPane.agent_status = "idle";
  assert.equal(mailboxDeliveries, countAfterAccepted + 1);
  panes.set("w-test:sibling", { pane_id: "w-test:sibling", tab_id: "w-test:external-tab", workspace_id: "w-test" });
  await execute({ action: "stop", id: external.getSessionId() });
  assert.ok(panes.has("w-test:sibling"), "stopping an external session must preserve unrelated panes");
  panes.delete("w-test:sibling");
  await assert.rejects(execute({ action: "focus", id: externalPath }), /use resume first/);
  result = await execute({ action: "watch", id: external.getSessionId(), timeoutSeconds: 1 });
  assert.match(result.content[0].text, /historical\/stopped/);

  await assert.rejects(
    execute({ action: "create", name: "Invalid model", message: "never launched", model: "missing-provider" }),
    /model must use provider\/model format/,
  );

  // A rejected startup prompt is a failed create, its tab is closed, and the
  // durable session remains visibly incomplete until an explicit retry succeeds.
  acceptNextInitialPrompt = false;
  let incompleteError: Error | undefined;
  try {
    await execute({ action: "create", name: "Rejected startup", message: "must be accepted", cwd: root });
  } catch (error) {
    incompleteError = error as Error;
  }
  assert.ok(incompleteError);
  assert.match(incompleteError.message, /^PI_SESSIONS_CREATE_INCOMPLETE /);
  const incompletePayload = JSON.parse(
    incompleteError.message.match(/^PI_SESSIONS_CREATE_INCOMPLETE (\{.*\})$/m)![1],
  );
  assert.equal(incompletePayload.startingMessageAccepted, false);
  assert.equal(incompletePayload.runtimeStatus, "stopped");
  assert.equal([...panes.values()].some((pane) => pane.agent_session?.value === incompletePayload.sessionPath), false);

  result = await execute({ action: "status", id: incompletePayload.sessionId });
  assert.match(result.content[0].text, /Status: incomplete/);
  assert.match(result.content[0].text, /Starting message: MISSING/);
  await assert.rejects(
    execute({ action: "resume", id: incompletePayload.sessionId }),
    /PI_SESSIONS_STARTING_MESSAGE_MISSING/,
  );
  result = await execute({
    action: "resume",
    id: incompletePayload.sessionId,
    message: "-recovered prompt isn't confused with an option-like prefix",
  });
  assert.match(result.content[0].text, /Recovery message sent and accepted/);
  result = await execute({ action: "read", id: incompletePayload.sessionId });
  assert.match(result.content[0].text, /-recovered prompt isn't confused with an option-like prefix/);
  await execute({ action: "stop", id: incompletePayload.sessionId });
  await unlink(incompletePayload.sessionPath);

  result = await execute({
    action: "create",
    name: "Lifecycle",
    message: "start",
    cwd: root,
    model: "openai-codex/gpt-5.6-luna",
  }, SessionManager.open(externalPath));
  const created = result.details.session;
  assert.match(created.id, /^dir_[0-9a-f]{32}$/);
  assert.equal(created.name, "Lifecycle");
  assert.ok(created.sessionPath.startsWith(join(agentDir, "sessions")));
  assert.equal(created.sessionPath.startsWith(join(sideAgentDir, "sessions")), false);
  assert.match(result.content[0].text, /Starting message sent/);
  const createdMetadata = SessionManager.open(created.sessionPath).getEntries().findLast(
    (entry: any) => entry.type === "custom" && entry.customType === "pi-session-orchestrator",
  )?.data;
  assert.equal(createdMetadata.parentSessionId, external.getSessionId());
  assert.equal(createdMetadata.delegationDepth, 1);
  assert.equal(createdMetadata.initialProvider, "openai-codex");
  assert.equal(createdMetadata.initialModel, "gpt-5.6-luna");
  const promptEvent = eventHandlers.get("before_agent_start")?.(
    { systemPrompt: "base prompt" },
    { sessionManager: SessionManager.open(created.sessionPath) },
  ) as { systemPrompt?: string };
  assert.match(promptEvent.systemPrompt ?? "", /owns its assigned task \(delegation depth 1\)/);
  assert.doesNotMatch(promptEvent.systemPrompt ?? "", /User:|Assistant:/);

  result = await execute({ action: "list" });
  assert.match(result.content[0].text, /Lifecycle/);
  assert.match(result.content[0].text, /idle/);

  const prefix = created.id.slice(0, 12);
  result = await execute({ action: "status", id: prefix });
  assert.match(result.content[0].text, /Status: idle/);
  await assert.rejects(execute({ action: "status", id: "dir_" }), /Ambiguous Pi session query/);
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

  await eventHandlers.get("session_start")?.({}, { sessionManager: SessionManager.open(created.sessionPath) });
  await execute({ action: "rename", id: "self", name: "Self renamed" });
  result = await execute({ action: "status", id: "self" });
  assert.match(result.content[0].text, /\(Self renamed\)/);
  await assert.rejects(execute({ action: "send", id: "self", message: "loop" }), /current Pi session/);
  await eventHandlers.get("session_start")?.({}, { sessionManager: SessionManager.open(externalPath) });

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
  assert.ok(
    herdrCalls.some((args) => args[0] === "tab" && args[1] === "close" && args[2] === "w-test:moved-tab"),
    "stop must close the managed tab so watch cannot retain a stale idle runtime",
  );
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

  resumedPane.agent_status = "working";
  const snapshotsBefore = herdrCalls.filter((args) => args[0] === "api").length;
  result = await execute({ action: "watch", id: created.sessionPath, timeoutSeconds: 1 });
  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.status, "working");
  assert.ok(herdrCalls.filter((args) => args[0] === "api").length - snapshotsBefore <= 3,
    "watch must not repeatedly discover the runtime while resolving the same target");
  resumedPane.agent_status = "idle";
  panes.set("w-test:duplicate", { ...resumedPane, pane_id: "w-test:duplicate" });
  result = await execute({ action: "status", id: created.sessionPath });
  assert.equal(result.details.status, "multiple", "two idle runtimes are still a duplicate-runtime conflict");
  await assert.rejects(execute({ action: "send", id: created.sessionPath, message: "unsafe duplicate target" }), /multiple Herdr panes/);
  panes.delete("w-test:duplicate");

  // Task sessions can override thinking and automatically close their Herdr tab while preserving history.
  const taskResult = await execute({
    action: "create",
    name: "Task worker",
    message: "one task",
    cwd: root,
    lifecycle: "task",
    thinking: "high",
  });
  const task = taskResult.details.session;
  assert.equal(task.lifecycle, "task");
  assert.equal(task.thinking, "high");
  assert.match(taskResult.content[0].text, /Lifecycle: task/);
  settle(task.sessionPath);
  settle(task.sessionPath); // Repeated lifecycle notifications must be idempotent.
  assert.equal(SessionManager.open(task.sessionPath).getEntries().filter((entry: any) =>
    entry.type === "custom" && entry.customType === "pi-session-run-settled").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.ok(SessionManager.open(task.sessionPath).getEntries().length > 0);
  assert.equal([...panes.values()].some((pane) => pane.agent_session?.value === task.sessionPath), false);

  // Session-file deletion naturally removes the durable record.
  await execute({ action: "stop", id: created.id });
  await unlink(created.sessionPath);
  result = await execute({ action: "list" });
  assert.doesNotMatch(result.content[0].text, /Manual name/);

  // Cleanup errors must leave the task inspectable and never claim a successful closure.
  failTabClose = true;
  const cleanupTask = (await execute({ action: "create", name: "Cleanup failure", message: "done", lifecycle: "task" })).details.session;
  result = await execute({ action: "watch", id: cleanupTask.sessionPath, timeoutSeconds: 1 });
  assert.equal(result.details.outcome, "completed");
  assert.equal(result.details.cleanedUp, false);
  assert.match(result.details.cleanupError, /cleanup unavailable/);
  assert.ok([...panes.values()].some((pane) => pane.agent_session?.value === cleanupTask.sessionPath));
  failTabClose = false;
  await execute({ action: "stop", id: cleanupTask.sessionPath });

  // A fresh orchestrator still sees durable completion after automatic runtime cleanup.
  await eventHandlers.get("session_shutdown")?.({});
  orchestrator(fakePi);
  result = await execute({ action: "watch", id: task.sessionPath, timeoutSeconds: 1 });
  assert.equal(result.details.outcome, "completed");
  assert.equal(result.details.cleanedUp, false, "already-closed tasks must not claim another tab closure");
  // Exercise the real extension binding: direct Pi API, explicit no-template expansion,
  // no editor access, and a stale session context cannot receive another prompt.
  const bindingEvents = new Map<string, (...args: any[]) => unknown>();
  const bindingContext = {
    mode: "tui", sessionManager: SessionManager.open(externalPath),
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: () => {}, setEditorText: () => { throw new Error("draft touched"); } },
  };
  let apiDeliveries = 0;
  orchestrator({ ...fakePi,
    on: (name: string, handler: (...args: any[]) => unknown) => bindingEvents.set(name, handler),
    registerTool: () => {},
    sendUserMessage: (content: string, options: unknown) => {
      apiDeliveries++;
      assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: false });
      bindingContext.sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
    },
  });
  const previousPaneId = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "w-test:binding";
  try {
    await bindingEvents.get("session_start")!({}, bindingContext);
    const identity = { sessionId: external.getSessionId(), sessionPath: externalPath, paneId: "w-test:binding" };
    const delivered = await sendMailbox(join(agentDir, "pi-sessions-ipc"), identity, "/literal-not-a-command");
    assert.equal(delivered.state, "accepted");
    assert.equal(apiDeliveries, 1);
    bindingContext.sessionManager = SessionManager.open(legacyPath);
    await assert.rejects(sendMailbox(join(agentDir, "pi-sessions-ipc"), identity, "wrong session"), /Mailbox target changed/);
    assert.equal(apiDeliveries, 1);
  } finally {
    await bindingEvents.get("session_shutdown")!({});
    if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPaneId;
  }
  console.log("pi-session-orchestrator lifecycle, recall, and mailbox tests passed");
} finally {
  await eventHandlers.get("session_shutdown")?.({});
  await Promise.all([...receivers.values()].map((receiver) => receiver.close()));
  await rm(root, { recursive: true, force: true });
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
