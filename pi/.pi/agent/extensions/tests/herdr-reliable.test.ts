import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import extension from "../herdr-reliable/index.ts";
import { Reporter, request, type Snapshot } from "../herdr-reliable/reporter.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for reporter");
    await sleep(5);
  }
}

async function fakeHerdr(socketPath?: string) {
  const directory = socketPath ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-test-"));
  const endpoint = socketPath ?? path.join(directory!, "herdr.sock");
  const calls: any[] = [];
  const sockets = new Set<net.Socket>();
  const state = {
    reject: 0, fragment: false, apply: true, delayMs: 0, sequence: 0,
    pane: { agent: "pi", agent_status: "unknown", agent_session: undefined } as any,
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", async data => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const call = JSON.parse(buffer.split("\n")[0]);
      calls.push(call);
      const { method, params } = call;
      let response: any;
      if (state.reject > 0) {
        state.reject--;
        response = { id: call.id, error: { code: "pane_not_found", message: "restore not ready" } };
      } else {
        if (state.apply && (params.seq === undefined || params.seq > state.sequence)) {
          if (method === "pane.report_agent_session" || method === "pane.report_agent") {
            if (params.seq !== undefined) state.sequence = params.seq;
            state.pane.agent_session = {
              source: params.source, value: params.agent_session_path ?? params.agent_session_id,
            };
          }
          if (method === "pane.report_agent") state.pane.agent_status = params.state;
        }
        response = { id: call.id, result: { type: "pane_info", pane: structuredClone(state.pane) } };
      }
      if (state.delayMs) await sleep(state.delayMs);
      if (socket.destroyed) return;
      const json = JSON.stringify(response) + "\n";
      if (state.fragment) {
        socket.write(json.slice(0, 7));
        await sleep(3);
        if (!socket.destroyed) socket.end(json.slice(7));
      } else socket.end(json);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(endpoint, resolve).once("error", reject));
  return {
    endpoint, calls, state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

function reporter(endpoint: string, snapshot: () => Snapshot, extras = {}) {
  return new Reporter({
    socketPath: endpoint, paneId: "test:p1", snapshot,
    retryMs: 10, maxRetryMs: 30, heartbeatMs: 40, timeoutMs: 300, ...extras,
  });
}
const idle = (): Snapshot => ({ state: "idle", sessionPath: "/tmp/fake-pi-session.jsonl", reason: "resume" });

test("socket transport checks error replies and buffers fragmented acknowledgments", async () => {
  const server = await fakeHerdr();
  try {
    server.state.reject = 1;
    await assert.rejects(request(server.endpoint, "pane.get", {}, new AbortController().signal), /pane_not_found/);
    server.state.fragment = true;
    const result = await request(server.endpoint, "pane.get", {}, new AbortController().signal);
    assert.equal(result.type, "pane_info");
  } finally { await server.close(); }
});

test("a missing socket at startup recovers without another Pi lifecycle event", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-delay-"));
  const endpoint = path.join(dir, "herdr.sock");
  const r = reporter(endpoint, idle);
  let server: Awaited<ReturnType<typeof fakeHerdr>> | undefined;
  try {
    assert.equal(await r.refresh(), false);
    server = await fakeHerdr(endpoint);
    await until(() => server!.state.pane.agent_status === "idle" && r.lastError === undefined);
    assert.equal(server.calls[0].params.session_start_source, "resume");
  } finally {
    r.dispose();
    await server?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejected startup reports are retried with native session and startup reason", async () => {
  const server = await fakeHerdr();
  const r = reporter(server.endpoint, idle);
  try {
    server.state.reject = 2;
    assert.equal(await r.refresh(), false);
    await until(() => server.state.pane.agent_status === "idle" && r.lastError === undefined);
    assert.ok(server.calls.length >= 5);
    for (const call of server.calls.filter(call => call.method === "pane.report_agent_session")) {
      assert.equal(call.params.session_start_source, "resume");
      assert.equal(call.params.agent_session_path, "/tmp/fake-pi-session.jsonl");
    }
  } finally { r.dispose(); await server.close(); }
});

test("successful but unapplied responses are detected, then retried", async () => {
  const server = await fakeHerdr();
  const r = reporter(server.endpoint, idle);
  try {
    server.state.apply = false;
    assert.equal(await r.refresh(), false);
    assert.match(r.lastError!, /has not applied/);
    server.state.apply = true;
    await until(() => server.state.pane.agent_status === "idle" && r.lastError === undefined);
  } finally { r.dispose(); await server.close(); }
});

test("heartbeat repairs lost server state and samples Pi's current idle/working state", async () => {
  const server = await fakeHerdr();
  let snapshot = idle();
  const r = reporter(server.endpoint, () => snapshot);
  try {
    r.start();
    await until(() => server.state.pane.agent_status === "idle");
    server.state.pane.agent_session = undefined;
    server.state.pane.agent_status = "unknown";
    snapshot = { ...snapshot, state: "working" };
    await until(() => server.state.pane.agent_status === "working");
    snapshot = { ...snapshot, state: "idle" };
    await until(() => server.state.pane.agent_status === "idle");
  } finally { r.dispose(); await server.close(); }
});

test("updates during an in-flight sync are coalesced and identity/state reports stay ordered", async () => {
  const server = await fakeHerdr();
  let snapshot: Snapshot = { ...idle(), state: "working" };
  const r = reporter(server.endpoint, () => snapshot);
  try {
    server.state.delayMs = 10;
    const first = r.refresh();
    await until(() => server.calls.length === 1);
    snapshot = { ...snapshot, state: "idle" };
    const final = r.refresh();
    assert.equal(await first, true);
    assert.equal(await final, true);
    assert.equal(server.state.pane.agent_status, "idle");
    assert.deepEqual(server.calls.map(call => call.method), [
      "pane.report_agent_session", "pane.report_agent", "pane.get",
      "pane.report_agent_session", "pane.report_agent", "pane.get",
    ]);
    const seqs = server.calls.filter(call => call.params.seq !== undefined).map(call => call.params.seq);
    assert.ok(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]));
  } finally { r.dispose(); await server.close(); }
});

test("an old hook's future-dated sequence can be repaired for the same native session", async () => {
  const server = await fakeHerdr();
  const r = reporter(server.endpoint, idle);
  try {
    server.state.sequence = Number.MAX_SAFE_INTEGER;
    server.state.pane.agent_session = { source: "herdr:pi", value: idle().sessionPath };
    server.state.pane.agent_status = "working";
    assert.equal(await r.refresh(), true);
    assert.equal(server.state.pane.agent_status, "idle");
    assert.equal(server.calls.findLast(call => call.method === "pane.report_agent").params.seq, undefined);
  } finally { r.dispose(); await server.close(); }
});

test("report sequences survive a backwards clock adjustment across reporter reloads", async () => {
  const server = await fakeHerdr();
  const first = reporter(server.endpoint, idle);
  const originalNow = Date.now;
  let second: Reporter | undefined;
  try {
    assert.equal(await first.refresh(), true);
    first.dispose();
    const previous = server.state.sequence;
    Date.now = () => originalNow() - 3 * 60 * 60 * 1000;
    second = reporter(server.endpoint, idle);
    assert.equal(await second.refresh(), true);
    assert.ok(server.state.sequence > previous);
  } finally {
    Date.now = originalNow;
    first.dispose(); second?.dispose(); await server.close();
  }
});

test("sequence repair cannot overwrite a different native session", async () => {
  const server = await fakeHerdr();
  const r = reporter(server.endpoint, idle);
  try {
    server.state.sequence = Number.MAX_SAFE_INTEGER;
    server.state.pane.agent_session = { source: "herdr:pi", value: "/tmp/someone-else.jsonl" };
    assert.equal(await r.refresh(), false);
    assert.ok(server.calls.filter(call => call.method === "pane.report_agent").every(call => call.params.seq !== undefined));
  } finally { r.dispose(); await server.close(); }
});

test("heartbeat reconnects after a server socket disappears and is recreated", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-reconnect-"));
  const endpoint = path.join(directory, "herdr.sock");
  let server = await fakeHerdr(endpoint);
  const r = reporter(endpoint, idle);
  try {
    r.start();
    await until(() => server.state.pane.agent_status === "idle");
    await server.close();
    await until(() => r.lastError !== undefined);
    server = await fakeHerdr(endpoint);
    await until(() => server.state.pane.agent_status === "idle" && r.lastError === undefined);
  } finally {
    r.dispose(); await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("disposal aborts pending transport and removes retry/heartbeat timers", async () => {
  const server = await fakeHerdr();
  const r = reporter(server.endpoint, idle);
  try {
    server.state.delayMs = 100;
    r.start();
    await until(() => server.calls.length > 0);
    r.dispose();
    const count = server.calls.length;
    await sleep(130);
    assert.equal(server.calls.length, count);
    assert.equal(await r.refresh(), false);
  } finally { r.dispose(); await server.close(); }
});

test("headless modes never register an agent or start a reporting timer", async () => {
  const server = await fakeHerdr();
  const previous = { ...process.env };
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = server.endpoint;
    process.env.HERDR_PANE_ID = "test:p1";
    for (const mode of ["rpc", "json", "print"]) {
      const handlers = new Map<string, Function>();
      let blocked: Function | undefined;
      extension({ on: (name: string, fn: Function) => handlers.set(name, fn),
        events: { on: (_name: string, fn: Function) => { blocked = fn; } }, registerCommand() {},
      } as any);
      const ctx = { mode, isIdle: () => true };
      handlers.get("session_start")!({ reason: "resume" }, ctx);
      handlers.get("agent_start")!({}, ctx);
      blocked!({ active: true });
      handlers.get("agent_settled")!({}, ctx);
      handlers.get("session_shutdown")!({}, ctx);
    }
    await sleep(50);
    assert.equal(server.calls.length, 0);
  } finally {
    for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await server.close();
  }
});

test("interactive blocked nesting, working/settled events and shutdown preserve lifecycle", async () => {
  const server = await fakeHerdr();
  const previous = { ...process.env };
  const handlers = new Map<string, Function>();
  let blocked: Function | undefined;
  let isIdle = true;
  const ctx = { mode: "tui", isIdle: () => isIdle,
    sessionManager: { getSessionFile: () => idle().sessionPath, getSessionId: () => "fake" },
  };
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = server.endpoint;
    process.env.HERDR_PANE_ID = "test:p1";
    extension({ on: (name: string, fn: Function) => handlers.set(name, fn),
      events: { on: (_name: string, fn: Function) => { blocked = fn; } }, registerCommand() {},
    } as any);
    handlers.get("session_start")!({ reason: "resume" }, ctx);
    await until(() => server.state.pane.agent_status === "idle");
    isIdle = false;
    handlers.get("agent_start")!({}, ctx);
    await until(() => server.state.pane.agent_status === "working");
    blocked!({ active: true, label: "Needs input" });
    blocked!({ active: true, label: "Needs input" });
    await until(() => server.state.pane.agent_status === "blocked");
    blocked!({ active: false });
    await sleep(10);
    assert.equal(server.state.pane.agent_status, "blocked");
    blocked!({ active: false });
    await until(() => server.state.pane.agent_status === "working");
    isIdle = true;
    handlers.get("agent_settled")!({}, ctx);
    await until(() => server.state.pane.agent_status === "idle");
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await server.close();
  }
});
