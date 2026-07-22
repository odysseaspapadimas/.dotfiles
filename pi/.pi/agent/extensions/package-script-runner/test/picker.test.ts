import assert from "node:assert/strict";
import test from "node:test";
import { filterProjectScripts, filterScripts, orderProjectScripts } from "../index.js";
import { serviceSlotKey } from "../src/herdr.js";
import type { PackageScript, PackageScriptProject } from "../src/discovery.js";

const scripts: PackageScript[] = [
  { name: "build", body: "tsc -b", invocation: "npm run build", command: "cd -- '/repo' && npm run build" },
  { name: "test:unit", body: "vitest run", invocation: "npm run test:unit", command: "cd -- '/repo' && npm run test:unit" },
  { name: "dev", body: "vite", invocation: "npm run dev", command: "cd -- '/repo' && npm run dev" },
];

test("search filters names and script bodies while preferring name prefixes", () => {
  assert.deepEqual(filterScripts(scripts, "test").map((script) => script.name), ["test:unit"]);
  assert.deepEqual(filterScripts(scripts, "tsc").map((script) => script.name), ["build"]);
  assert.deepEqual(filterScripts(scripts, "run").map((script) => script.name), ["test:unit"]);
  assert.deepEqual(filterScripts(scripts, "").map((script) => script.name), ["build", "test:unit", "dev"]);
});

test("workspace search combines repository and script terms", () => {
  const project = (label: string, selectedScripts: PackageScript[]): PackageScriptProject => ({
    label,
    manifest: "package.json",
    root: `/workspace/${label}`,
    boundary: `/workspace/${label}`,
    packageJsonPath: `/workspace/${label}/package.json`,
    manager: "npm",
    scripts: selectedScripts,
  });
  const projects = [project("backend", [scripts[1]!]), project("frontend", [scripts[0]!, scripts[2]!])];
  assert.deepEqual(
    filterProjectScripts(projects, "front dev").map((choice) => `${choice.project.label}/${choice.script.name}`),
    ["frontend/dev"],
  );
  assert.deepEqual(
    filterProjectScripts(projects, "backend").map((choice) => choice.script.name),
    ["test:unit"],
  );

  const choices = filterProjectScripts(projects, "");
  const running = new Set([serviceSlotKey("/workspace/frontend", "npm run dev")]);
  assert.deepEqual(
    orderProjectScripts(choices, running, true).map((choice) => `${choice.project.label}/${choice.script.name}`),
    ["frontend/dev", "backend/test:unit", "frontend/build"],
  );
  assert.deepEqual(orderProjectScripts(choices, running, false), choices);
});
