import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionStore, type ManagedSession } from "../pi-sessions/store.ts";
import { recall } from "../pi-sessions/recall.ts";

class CountingStore extends SessionStore {
  loaded: string[] = [];
  override async load(...args: Parameters<SessionStore["load"]>) {
    this.loaded.push(args[0]);
    return super.load(...args);
  }
}
class FullScanStore extends CountingStore {
  override scan(signal?: AbortSignal, _filter?: (session: ManagedSession) => boolean) {
    return super.scan(signal);
  }
}

test("indexed recall filters project and excluded paths before loading; rankings and message dates stay identical", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-recall-filter-"));
  const root = join(directory, "sessions"), index = join(directory, "index.json");
  const paths: string[] = [];
  try {
    for (const [i, cwd] of ["/projects/target", "/projects/other", "/projects/target"].entries()) {
      const project = join(root, String(i)); await mkdir(project, { recursive: true });
      const manager = SessionManager.create(cwd, project);
      manager.appendSessionInfo(`Session ${i}`);
      manager.appendMessage({ role: "user", content: "session performance", timestamp: Date.UTC(2026, 0, 1) + i * 1000 });
      paths.push(manager.getSessionFile()!);
      await writeFile(paths[i], [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    }
    await new SessionStore(root, index).list();
    const options = { query: "session performance", cwd: "TARGET", excludePath: paths[2],
      after: Date.UTC(2025, 11, 31), before: Date.UTC(2026, 0, 2), limit: 5, offset: 0 };
    const indexed = new CountingStore(root, index);
    const result = await recall(indexed, options);
    assert.deepEqual(indexed.loaded, [paths[0]]);
    assert.equal(result.total, 1);
    assert.deepEqual(result, await recall(new FullScanStore(root, null), options));
    // File mtime is recent, but message dates are old: bounds must still use messages.
    assert.equal((await recall(indexed, { ...options, after: Date.UTC(2026, 0, 3) })).total, 0);
    // An atomic replacement changing the cwd must invalidate the prefilter.
    await writeFile(paths[1], (await readFile(paths[1], "utf8")).replace("/projects/other", "/projects/target"));
    indexed.loaded = [];
    assert.equal((await recall(indexed, options)).total, 2);
    assert.deepEqual(new Set(indexed.loaded), new Set([paths[0], paths[1]]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cold filtered scans parse each transcript once and warm subsequent stores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-recall-cold-"));
  try {
    const root = join(directory, "sessions"), project = join(root, "project"), index = join(directory, "index.json");
    await mkdir(project, { recursive: true });
    const manager = SessionManager.create("/other", project);
    const path = manager.getSessionFile()!;
    await writeFile(path, JSON.stringify(manager.getHeader()) + "\n");
    const cold = new CountingStore(root, index);
    assert.equal((await recall(cold, { cwd: "/target", limit: 5, offset: 0 })).total, 0);
    assert.deepEqual(cold.loaded, [path]);
    const warm = new CountingStore(root, index);
    assert.equal((await recall(warm, { cwd: "/target", limit: 5, offset: 0 })).total, 0);
    assert.deepEqual(warm.loaded, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
