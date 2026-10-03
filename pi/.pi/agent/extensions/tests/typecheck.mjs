import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { host } from "./pi-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-extensions-typecheck-"));
const paths = {};
for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
  const packageRoot = name === "pi-coding-agent" ? host : join(host, "node_modules", "@earendil-works", name);
  paths["@earendil-works/" + name] = [join(packageRoot, "dist", name === "pi-ai" ? "compat.d.ts" : "index.d.ts")];
  paths["@earendil-works/" + name + "/*"] = [join(packageRoot, "dist", "*.d.ts")];
}
paths.typebox = [join(host, "node_modules/typebox/build/index.d.mts")];
paths["typebox/*"] = [join(host, "node_modules/typebox/build/*/index.d.mts")];
const dependencies = join(root, "changed-files-ledger/node_modules");
try {
  const config = join(temporary, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"],
      typeRoots: [join(dependencies, "@types")], paths },
    include: [join(root, "**/*.ts")], exclude: ["**/node_modules/**"],
  }));
  const result = spawnSync(process.execPath, [join(dependencies, "typescript/bin/tsc"), "-p", config], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
