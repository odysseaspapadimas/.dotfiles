// Use Pi's installed SDK and its own Jiti aliases; no project npm install needed.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.PI_SESSIONS_TEST_CHILD !== "1") {
  const tests = process.argv.slice(2);
  for (const test of tests.length ? tests : ["pi-session-orchestrator.test.ts", "pi-sessions-core.test.ts"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), resolve(here, test)], {
      stdio: "inherit", env: { ...process.env, PI_SESSIONS_TEST_CHILD: "1" },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
} else {
  const install = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi", "agent", "install");
  const modules = process.env.PI_TEST_NODE_MODULES || join(install, "releases",
    (await readFile(join(install, "current-version"), "utf8")).trim(), "node_modules");
  const require = createRequire(join(modules, "@earendil-works", "pi-coding-agent", "package.json"));
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    "@earendil-works/pi-ai": join(modules, "@earendil-works", "pi-ai", "dist", "compat.js"),
    "@earendil-works/pi-tui": join(modules, "@earendil-works", "pi-tui", "dist", "index.js"),
    "typebox/value": require.resolve("typebox/value"),
    "typebox/compile": require.resolve("typebox/compile"),
    typebox: require.resolve("typebox"),
  } });
  await jiti.import(process.argv[2]);
}
