// No provider calls: shared real Pi discovery + runtime-selected adapter contract.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(homedir(), ".pi/agent");
const install = join(agentDir, "install");
const modules = join(install, "releases", (await readFile(join(install, "current-version"), "utf8")).trim(), "node_modules");
const sdkPath = join(modules, "@earendil-works/pi-coding-agent/dist/index.js");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HC_TERMINAL_ID = "t7";
process.env.HC_TERMINAL_SOCKET = "/nonexistent-test-core.sock";
for (const key of Object.keys(process.env)) if (key.startsWith("HERDR_") || key.startsWith("PI_HERDR_") || key === "PI_APP_PROFILE") delete process.env[key];
const sdk = await import(pathToFileURL(sdkPath).href);
const temporary = await mkdtemp("/tmp/pi-app-shared-");
try {
  const loader = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir,
    settingsManager: sdk.SettingsManager.create(temporary, agentDir, { projectTrusted: false }) });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
  assert.ok(loaded.extensions.some(e => e.resolvedPath.endsWith("/herdr-app.ts")), "ordinary pi discovers the automatic adapter");
  assert.ok(loaded.extensions.some(e => e.resolvedPath.endsWith("/pi-session-orchestrator.ts")), "same session store/orchestrator");
  assert.ok(loaded.extensions.some(e => e.resolvedPath.includes("pi-web-access")), "neutral packages remain shared");
  assert.ok(loader.getSkills().skills.some(s => s.name === "browser-control"), "neutral skills are retained");
  console.log("Real ordinary-Pi discovery PASS:", loaded.extensions.length, "extensions", loader.getSkills().skills.length, "skills");

  const require = createRequire(join(modules, "@earendil-works/pi-coding-agent/package.json"));
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": sdkPath, typebox: require.resolve("typebox") } });
  const factory = (await jiti.import(join(root, "extensions/herdr-app.ts"))).default;
  const handlers = new Map(), tools = new Map(), executions = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    async exec(binary, args) { executions.push({ binary, args }); return { code: 0, stdout: '{"ok":true}', stderr: "" }; },
  };
  factory(pi);
  const tool = tools.get("herdr_app");
  assert.ok(tool);
  await tool.execute("1", { action: "current" });
  assert.deepEqual(executions.at(-1).args, ["current"]);
  await tool.execute("2", { action: "do", command: "pane.focus", args: { terminal: "t7" } });
  assert.deepEqual(executions.at(-1).args, ["do", "pane.focus", '{"terminal":"t7"}']);
  await tool.execute("3", { action: "status", client: "windows" });
  await tool.execute("4", { action: "status" });
  assert.deepEqual(executions.at(-1).args, ["status"], "explicit override must not bind a session to a client");
  const event = { systemPromptOptions: { sections: {}, skills: [{ name: "herdr" }, { name: "project-worktree" }, { name: "browser-control" }] } };
  handlers.get("before_agent_start")(event);
  assert.deepEqual(event.systemPromptOptions.skills.map(s => s.name), ["browser-control"]);
  assert.match(event.systemPromptOptions.sections.herdr_app, /No profile or desktop selection/);

  const sideFactory = (await jiti.import(join(agentDir, "extensions/herdr-side-chat.ts"))).default;
  sideFactory({}); // Should return before registering any old side-chat commands.
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "w1";
  factory({}); // Nested old TUI wins, so new adapter is inert.
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HC_TERMINAL_ID;
  factory({}); // Bare SSH shells do not accidentally drive desktop windows.
  console.log("Automatic adapter PASS: no selection, shared resources, request routing, runtime isolation");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
