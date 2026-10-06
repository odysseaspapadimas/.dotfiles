import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Reporter, type Snapshot } from "./reporter.ts";

/** Local replacement for the managed Herdr hook (excluded in personal settings.json). */
export default function herdrReliable(pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;

  let context: ExtensionContext | undefined;
  let reporter: Reporter | undefined;
  let reason = "startup";
  let blockedCount = 0;
  let blockedMessage: string | undefined;

  function snapshot(): Snapshot {
    if (!context) throw new Error("Pi's interactive session is not running");
    const file = context.sessionManager.getSessionFile();
    const sessionPath = typeof file === "string" &&
      (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) ? file : undefined;
    return {
      state: blockedCount > 0 ? "blocked" : context.isIdle() ? "idle" : "working",
      message: blockedCount > 0 ? blockedMessage : undefined,
      sessionPath,
      sessionId: sessionPath ? undefined : context.sessionManager.getSessionId(),
      reason,
    };
  }

  pi.on("session_start", (event, ctx) => {
    // RPC advertises hasUI as well. Never let headless workers claim their parent's pane.
    if (ctx.mode !== "tui") return;
    reporter?.dispose();
    context = ctx;
    reason = event.reason;
    blockedCount = 0;
    blockedMessage = undefined;
    reporter = new Reporter({ socketPath, paneId, snapshot });
    reporter.start();
  });

  function refresh(_event: unknown, ctx: ExtensionContext) {
    if (!context || ctx.mode !== "tui") return;
    context = ctx;
    void reporter?.refresh();
  }
  pi.on("agent_start", refresh);
  pi.on("agent_settled", refresh);

  pi.events.on("herdr:blocked", data => {
    if (!context || !data || typeof data !== "object" || !("active" in data)) return;
    if (data.active === true) {
      blockedCount += 1;
      blockedMessage = "label" in data && typeof data.label === "string" ? data.label : undefined;
    } else if (data.active === false) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (!blockedCount) blockedMessage = undefined;
    }
    void reporter?.refresh();
  });

  pi.on("session_shutdown", () => {
    reporter?.dispose();
    reporter = undefined;
    context = undefined;
    blockedCount = 0;
    blockedMessage = undefined;
  });

  pi.registerCommand("herdr-sync", {
    description: "Resynchronize this Pi session and status with Herdr without restarting",
    handler: async (_args, ctx) => {
      if (!reporter || ctx.mode !== "tui") return;
      context = ctx;
      const synced = await reporter.refresh();
      ctx.ui.notify(synced ? "Herdr session/status synchronized" :
        `Herdr sync is retrying automatically: ${reporter.lastError ?? "not ready"}`,
      synced ? "info" : "warning");
    },
  });
}
