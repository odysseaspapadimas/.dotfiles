// Resolve against the running Pi installation, never the ledger's older dev dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join } from "node:path";

export function findPiHost() {
  if (process.env.PI_TEST_HOST) return realpathSync(process.env.PI_TEST_HOST);
  let directory = dirname(realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim()));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the installed Pi package; set PI_TEST_HOST.");
    directory = parent;
  }
}

export const host = findPiHost();
export const hostRequire = createRequire(join(host, "package.json"));
register("./pi-host-loader.mjs", import.meta.url, { data: { host } });
