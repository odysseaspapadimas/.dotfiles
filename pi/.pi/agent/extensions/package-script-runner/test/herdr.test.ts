import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundProcesses,
  processSignature,
  ProjectScriptHerdrRunner,
  serviceSlotKey,
  workspaceServiceKey,
} from "../src/herdr.js";

interface Call { command: string; args: string[] }
function response(payload: unknown, code = 0) {
  return { stdout: JSON.stringify(payload), stderr: code === 0 ? "" : "failed", code, killed: false };
}

class FakeExec {
  calls: Call[] = [];
  processLists: unknown[][] = [];
  panes: Array<{ pane_id: string; tab_id: string; label?: string }> = [
    { pane_id: "p-source", tab_id: "t-source", label: "Pi" },
  ];
  tabs: Array<{ tab_id: string; label?: string }> = [{ tab_id: "t-source", label: "Pi" }];
  nextPane = 1;
  focusedPane = "p-source";

  async exec(command: string, args: string[]): Promise<ReturnType<typeof response>> {
    this.calls.push({ command, args: [...args] });
    const operation = args.slice(0, 2).join(" ");
    if (operation === "pane list") return response({ result: { panes: this.panes } });
    if (operation === "tab list") return response({ result: { tabs: this.tabs } });
    if (operation === "pane layout") return response({ result: { layout: {
      focused_pane_id: this.focusedPane,
      panes: this.panes.map((pane, index) => ({
        pane_id: pane.pane_id,
        rect: { x: index * 80, y: 0, width: 80, height: 40 },
      })),
    } } });
    if (operation === "pane process-info") {
      const processes = this.processLists.shift() ?? [];
      return response({ result: { process_info: { shell_pid: 1, foreground_processes: processes } } });
    }
    if (operation === "pane split") {
      const anchor = this.panes.find((pane) => pane.pane_id === args[2]);
      const pane = { pane_id: `p-${this.nextPane++}`, tab_id: anchor?.tab_id ?? "t-source" };
      this.panes.push(pane);
      this.focusedPane = pane.pane_id;
      return response({ result: { pane } });
    }
    if (operation === "tab create") {
      const label = args[args.indexOf("--label") + 1];
      const tab: { tab_id: string; label?: string } = { tab_id: "t-services", ...(label ? { label } : {}) };
      const root_pane = { pane_id: `p-${this.nextPane++}`, tab_id: tab.tab_id };
      this.tabs.push(tab);
      this.panes.push(root_pane);
      this.focusedPane = root_pane.pane_id;
      return response({ result: { tab, root_pane } });
    }
    if (operation === "pane rename") {
      const pane = this.panes.find((candidate) => candidate.pane_id === args[2]);
      if (pane && args[3]) pane.label = args[3];
    }
    if (operation === "pane close") this.panes = this.panes.filter((pane) => pane.pane_id !== args[2]);
    if (operation === "tab rename") {
      const tab = this.tabs.find((candidate) => candidate.tab_id === args[2]);
      if (tab && args[3]) tab.label = args[3];
    }
    if (operation === "pane focus" && args[3]) this.focusedPane = args[3];
    return response({ result: {} });
  }
}

function runner(fake: FakeExec) {
  return new ProjectScriptHerdrRunner(fake as never, "w1", "t-source", "p-source", "Project services · p1");
}

const frontend = { key: serviceSlotKey("/frontend", "pnpm run dev"), display: "frontend/dev" };
const backend = { key: serviceSlotKey("/backend", "npm run dev"), display: "backend/dev" };

test("process inspection excludes the shell and preserves foreground command identity", () => {
  const stdout = JSON.stringify({ result: { process_info: {
    shell_pid: 10,
    foreground_processes: [
      { pid: 10, name: "bash", cmdline: "bash" },
      { pid: 11, name: "node", cmdline: "node server.js" },
    ],
  } } });
  const processes = foregroundProcesses(stdout);
  assert.deepEqual(processes, [{ pid: 11, name: "node", cmdline: "node server.js" }]);
  assert.equal(processSignature(processes), "11:node server.js");
});

test("reuses the labeled adjacent split instead of accumulating panes", async () => {
  const fake = new FakeExec();
  fake.panes.push({ pane_id: "p-adjacent", tab_id: "t-source", label: "Project services · p1 · adjacent · p-source" });
  const target = await runner(fake).target("/repo", "pane");
  assert.equal(target.paneId, "p-adjacent");
  assert.equal(fake.calls.some((call) => call.args[1] === "split"), false);
});

test("workspace service identity is stable and path-specific", () => {
  assert.equal(workspaceServiceKey("/workspace"), workspaceServiceKey("/workspace"));
  assert.notEqual(workspaceServiceKey("/workspace-a"), workspaceServiceKey("/workspace-b"));
});

test("adopts services created by the old source-pane label", async () => {
  const fake = new FakeExec();
  fake.tabs.push({ tab_id: "t-old", label: "Project services · p7" });
  fake.panes.push({
    pane_id: "p-old-service",
    tab_id: "t-old",
    label: `Project services · p7 · service · ${frontend.key} · frontend/dev`,
  });
  fake.processLists.push([{ pid: 50, cmdline: "pnpm run dev" }]);
  const running = await runner(fake).runningServiceKeys([frontend]);
  assert.equal(running.has(frontend.key), true);
  assert.match(fake.panes.find((pane) => pane.pane_id === "p-old-service")?.label ?? "", /^Project services · p1/u);
  assert.equal(fake.tabs.find((tab) => tab.tab_id === "t-old")?.label, "Project services · p1");
});

test("creates and rediscovers a service slot by repository and script", async () => {
  const fake = new FakeExec();
  const created = await runner(fake).target("/frontend", "service", frontend);
  assert.equal(created.created, true);
  assert.match(fake.panes.find((pane) => pane.pane_id === created.paneId)?.label ?? "", /frontend\/dev/u);

  const rediscovered = await runner(fake).target("/frontend", "service", frontend);
  assert.equal(rediscovered.paneId, created.paneId);
  assert.equal(rediscovered.created, false);
  assert.equal(fake.calls.filter((call) => call.args[0] === "tab" && call.args[1] === "create").length, 1);
});

test("recycles an idle service pane for a different script", async () => {
  const fake = new FakeExec();
  const first = await runner(fake).target("/frontend", "service", frontend);
  fake.processLists.push([], []);
  const recycled = await runner(fake).target("/backend", "service", backend);
  assert.equal(recycled.paneId, first.paneId);
  assert.equal(fake.panes.filter((pane) => pane.label?.includes(" · service · ")).length, 1);
  assert.match(fake.panes.find((pane) => pane.pane_id === first.paneId)?.label ?? "", /backend\/dev/u);
});

test("status discovery prunes excess idle service panes without touching active ones", async () => {
  const fake = new FakeExec();
  fake.panes.push(
    { pane_id: "p-idle-1", tab_id: "t-services", label: `Project services · p1 · service · ${frontend.key} · frontend/dev` },
    { pane_id: "p-idle-2", tab_id: "t-services", label: `Project services · p1 · service · ${backend.key} · backend/dev` },
    { pane_id: "p-active", tab_id: "t-services", label: `Project services · p1 · service · active-key · app/start` },
  );
  fake.processLists.push([], [], [{ pid: 40, cmdline: "npm run start" }]);
  const running = await runner(fake).runningServiceKeys([frontend, backend, { key: "active-key", display: "app/start" }]);
  assert.equal(running.has("active-key"), true);
  assert.equal(fake.panes.some((pane) => pane.pane_id === "p-idle-1"), true);
  assert.equal(fake.panes.some((pane) => pane.pane_id === "p-idle-2"), false);
  assert.equal(fake.panes.some((pane) => pane.pane_id === "p-active"), true);
});

test("keeps a running service and creates a concurrent slot", async () => {
  const fake = new FakeExec();
  const first = await runner(fake).target("/frontend", "service", frontend);
  fake.processLists.push([{ pid: 21, cmdline: "pnpm run dev" }]);
  const second = await runner(fake).target("/backend", "service", backend);
  assert.notEqual(second.paneId, first.paneId);
  assert.equal(fake.panes.filter((pane) => pane.label?.includes(" · service · ")).length, 2);
});

test("refuses to interrupt when the process changed during the user decision", async () => {
  const fake = new FakeExec();
  fake.processLists.push([{ pid: 22, cmdline: "npm run other" }]);
  await assert.rejects(
    runner(fake).interrupt({ paneId: "p-runner", tabId: "t-source", kind: "pane", created: false }, "21:npm run dev"),
    /process changed/u,
  );
  assert.equal(fake.calls.some((call) => call.args[1] === "send-keys"), false);
});

test("an explicitly approved interrupt sends Ctrl+C and waits for idle", async () => {
  const fake = new FakeExec();
  fake.processLists.push([{ pid: 21, cmdline: "npm run dev" }], []);
  const target = { paneId: "p-runner", tabId: "t-source", kind: "pane" as const, created: false };
  await runner(fake).interrupt(target, "21:npm run dev");
  assert.equal(fake.calls.some((call) => call.args.join(" ") === "pane send-keys p-runner ctrl+c"), true);
});

test("launch tolerates transient shell work while requiring stable idle", async () => {
  const fake = new FakeExec();
  fake.panes.push({ pane_id: "p-runner", tab_id: "t-source" });
  fake.processLists.push([{ pid: 31, cmdline: "stty -icanon" }], [], []);
  const target = { paneId: "p-runner", tabId: "t-source", kind: "pane" as const, created: false };
  await runner(fake).run(target, "npm run test");
  assert.equal(fake.calls.some((call) => call.args.join(" ") === "pane run p-runner npm run test"), true);
});

test("launch rechecks that the reusable pane is idle", async () => {
  const fake = new FakeExec();
  for (let index = 0; index < 20; index += 1) fake.processLists.push([{ pid: 21, cmdline: "npm run dev" }]);
  await assert.rejects(
    runner(fake).run({ paneId: "p-runner", tabId: "t-source", kind: "pane", created: false }, "npm run test"),
    /became busy/u,
  );
  assert.equal(fake.calls.some((call) => call.args[1] === "run"), false);
});
