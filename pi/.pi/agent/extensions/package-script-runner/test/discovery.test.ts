import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectPackageManager,
  discoverPackageScripts,
  discoverPackageScriptWorkspace,
  executionCommand,
  scriptInvocation,
} from "../src/discovery.js";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-package-scripts-"));
  await mkdir(join(root, ".git"));
  return root;
}

test("discovers only package.json scripts without running package-manager commands", async () => {
  const root = await project();
  const nested = join(root, "packages", "app", "src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "packages", "app", "package.json"), JSON.stringify({
    scripts: { test: "vitest", build: "tsc -b", ignored: 42 },
  }));

  const result = await discoverPackageScripts(nested);
  assert.ok(result);
  assert.equal(result.manager, "pnpm");
  assert.equal(result.root, join(root, "packages", "app"));
  assert.deepEqual(result.scripts.map((script) => script.name), ["build", "test"]);
  assert.equal(result.scripts[1]?.invocation, "pnpm run test");
  assert.equal(result.scripts[1]?.command, `cd -- '${join(root, "packages", "app")}' && pnpm run test`);
});

test("uses the nearest lockfile and documented same-directory precedence", async () => {
  const root = await project();
  const app = join(root, "app");
  await mkdir(app);
  await writeFile(join(root, "pnpm-lock.yaml"), "");
  await writeFile(join(app, "yarn.lock"), "");
  await writeFile(join(app, "package-lock.json"), "{}");
  assert.equal(await detectPackageManager(app, root), "yarn");

  await writeFile(join(app, "pnpm-lock.yaml"), "");
  assert.equal(await detectPackageManager(app, root), "pnpm");
});

test("detects Bun lockfile variants and falls back to npm", async () => {
  const bunText = await project();
  await writeFile(join(bunText, "bun.lock"), "");
  assert.equal(await detectPackageManager(bunText), "bun");

  const bunBinary = await project();
  await writeFile(join(bunBinary, "bun.lockb"), "");
  assert.equal(await detectPackageManager(bunBinary), "bun");

  assert.equal(await detectPackageManager(await project()), "npm");
});

test("does not walk above cwd outside a Git worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-package-parent-"));
  const child = join(parent, "child");
  await mkdir(child);
  await writeFile(join(parent, "package.json"), JSON.stringify({ scripts: { unsafe: "echo no" } }));
  assert.equal(await discoverPackageScripts(child), undefined);
});

test("aggregates package scripts from immediate child Git repositories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-package-workspace-"));
  const repositories: Array<[string, string, string]> = [
    ["backend", "package-lock.json", "node server.js"],
    ["frontend", "pnpm-lock.yaml", "vite"],
  ];
  for (const [name, manager, script] of repositories) {
    const repository = join(workspace, name);
    await mkdir(join(repository, ".git"), { recursive: true });
    await writeFile(join(repository, manager), "");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { dev: script } }));
  }

  const result = await discoverPackageScriptWorkspace(workspace);
  assert.deepEqual(result.projects.map((entry) => entry.label), ["backend", "frontend"]);
  assert.deepEqual(result.projects.map((entry) => entry.manager), ["npm", "pnpm"]);
  assert.equal(result.projects[0]?.scripts[0]?.command, `cd -- '${join(workspace, "backend")}' && npm run dev`);
  assert.equal(result.projects[1]?.scripts[0]?.command, `cd -- '${join(workspace, "frontend")}' && pnpm run dev`);
});

test("discovers Composer string and array scripts beside package scripts", async () => {
  const root = await project();
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await writeFile(join(root, "composer.json"), JSON.stringify({ scripts: {
    serve: "php -S localhost:8000",
    checks: ["@php lint.php", "@php test.php"],
    ignored: { nested: true },
  } }));

  const result = await discoverPackageScriptWorkspace(root);
  assert.deepEqual(result.projects.map((entry) => entry.manifest), ["package.json", "composer.json"]);
  const composer = result.projects.find((entry) => entry.manifest === "composer.json");
  assert.ok(composer);
  assert.deepEqual(composer.scripts.map((script) => script.name), ["checks", "serve"]);
  assert.equal(composer.scripts[0]?.body, "@php lint.php → @php test.php");
  assert.equal(composer.scripts[1]?.command, `cd -- '${root}' && composer run-script serve`);
});

test("workspace discovery is bounded to immediate child repositories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-package-workspace-"));
  const nested = join(workspace, "group", "frontend");
  await mkdir(join(nested, ".git"), { recursive: true });
  await writeFile(join(nested, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  assert.deepEqual((await discoverPackageScriptWorkspace(workspace)).projects, []);
});

test("quotes unusual script names and project paths as shell data", () => {
  assert.equal(scriptInvocation("npm", "test; touch /tmp/nope"), "npm run 'test; touch /tmp/nope'");
  assert.equal(scriptInvocation("yarn", "it's"), "yarn run 'it'\\''s'");
  assert.equal(executionCommand("/tmp/a b", "npm run test"), "cd -- '/tmp/a b' && npm run test");
});
