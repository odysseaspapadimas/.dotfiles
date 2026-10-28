import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hostContract, type Result } from "./contract.ts";
import { tasksFromSession } from "./snapshot.ts";

const cache = new Map<string, { stamp: string; result: Result }>();
export async function readTasks(sessionId: string, directory: string, signal?: AbortSignal): Promise<Result> {
  // Defense in depth: filenames must never accept paths from the browser.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session id");
  const file = join(directory, sessionId + ".jsonl");
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (stat.size > 64 * 1024 * 1024) return { tasks: [], error: "Task list unavailable: Pi session exceeds 64 MiB." };
      const stamp = stat.dev + ":" + stat.ino + ":" + stat.size + ":" + stat.mtimeMs;
      const cached = cache.get(file);
      if (cached?.stamp === stamp) return cached.result;
      signal?.throwIfAborted();
      // Pin the size so appends during this read are picked up on the next poll.
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, Math.min(1024 * 1024, buffer.length - offset), offset);
        if (!bytesRead) throw new Error("Session changed during read");
        offset += bytesRead;
      }
      // A concurrent append can leave a partial final JSONL line. Only consume
      // complete entries; the next size change retries the unfinished line.
      const complete = buffer.subarray(0, buffer.lastIndexOf(10) + 1).toString("utf8");
      const result: Result = { tasks: tasksFromSession(complete), error: null };
      cache.set(file, { stamp, result });
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      return result;
    } finally { await handle.close(); }
  } catch (error) {
    if (signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], error: "Pi task state is not available on this machine yet." };
    return { tasks: [], error: "Could not read Pi task state. It will retry automatically." };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readTasks: ({ sessionId }, context) => readTasks(
      sessionId,
      resolve(process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions")),
      context.signal,
    ),
  },
});
