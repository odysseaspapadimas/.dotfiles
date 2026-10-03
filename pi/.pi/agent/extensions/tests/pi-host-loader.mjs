import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { transform } = createRequire(new URL("../changed-files-ledger/package.json", import.meta.url))("esbuild");
let host;
let require;
export function initialize(data) {
  host = data.host;
  require = createRequire(join(host, "package.json"));
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const filename = fileURLToPath(url);
    const { code } = await transform(readFileSync(filename, "utf8"), { loader: "ts", format: "esm", target: "es2024", sourcefile: filename, sourcemap: "inline" });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  const prefix = "@earendil-works/";
  if (specifier.startsWith(prefix)) {
    const [name, ...subpath] = specifier.slice(prefix.length).split("/");
    if (["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].includes(name)) {
      const root = name === "pi-coding-agent" ? host : join(host, "node_modules", prefix + name);
      // Pi's jiti loader intentionally maps the pi-ai root to its compat entrypoint.
      const entry = subpath.length ? subpath.join("/") : name === "pi-ai" ? "compat" : "index";
      return { url: pathToFileURL(join(root, "dist", entry + ".js")).href, shortCircuit: true };
    }
  }
  if (specifier === "typebox" || specifier.startsWith("typebox/")) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // TypeScript's NodeNext .js imports refer to the source .ts files in this repo.
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    throw error;
  }
}
