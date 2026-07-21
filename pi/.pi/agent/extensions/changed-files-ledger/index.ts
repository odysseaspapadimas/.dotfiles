import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
  bundledHunkSkillPath,
  type HunkOpenTarget,
  HunkHerdrViewer,
} from "./src/herdr.js";
import {
  type DiffStats,
  type Snapshot,
  ChangedFilesLedger,
  changedPaths,
  emptyStats,
  formatStats,
} from "./src/ledger.js";

const WIDGET_ID = "changed-files-ledger";
const ENTRY_TYPE = "pi-changed-files-ledger-v1";

interface TurnDraft {
  id: string;
  turnIndex: number;
  startedAt: string;
  before: Snapshot;
}

interface ScopeSelection {
  scopeId: string;
  target: HunkOpenTarget;
}

export default function changedFilesLedgerExtension(pi: ExtensionAPI) {
  let ledger: ChangedFilesLedger | undefined;
  let viewer: HunkHerdrViewer | undefined;
  let draft: TurnDraft | undefined;
  let nextTurnIndex = 0;
  let live: Snapshot | undefined;
  let currentStats: DiffStats = emptyStats();
  let sessionStats: DiffStats = emptyStats();
  let widgetHidden = false;
  let disabledReason: string | undefined;
  let initialized: Promise<void> = Promise.resolve();

  pi.on("resources_discover", () => ({ skillPaths: [bundledHunkSkillPath] }));

  function updateDisabledStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || widgetHidden) return;
    const detail = disabledReason?.includes("not inside a Git worktree")
      ? "not a Git project"
      : disabledReason?.includes("candidate files")
        ? "too many project files"
        : "safety limit exceeded";
    ctx.ui.setStatus(WIDGET_ID, ctx.ui.theme.fg("warning", `changes: disabled (${detail})`));
  }

  function formatWidgetStats(
    ctx: ExtensionContext,
    label: string,
    stats: DiffStats,
    tone: "accent" | "muted",
  ): string {
    return [
      ctx.ui.theme.fg(tone, `${label} ${stats.files}f · `),
      ctx.ui.theme.fg("success", `+${stats.additions}`),
      ctx.ui.theme.fg(tone, " · "),
      ctx.ui.theme.fg("error", `−${stats.deletions}`),
      stats.binary > 0 ? ctx.ui.theme.fg(tone, ` · ${stats.binary} binary`) : "",
    ].join("");
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (widgetHidden) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(WIDGET_ID, undefined);
      return;
    }
    const line = [
      formatWidgetStats(ctx, "turn", currentStats, "accent"),
      ctx.ui.theme.fg("dim", "│"),
      formatWidgetStats(ctx, "session", sessionStats, "muted"),
    ].join(" ");
    ctx.ui.setStatus(WIDGET_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, [line]);
  }

  async function refreshStats(ctx: ExtensionContext): Promise<void> {
    await initialized;
    if (!ledger?.index) return;
    const latest = live ?? ledger.index.latest;
    currentStats = draft
      ? await ledger.calculateStats(draft.before, latest)
      : ledger.currentScope(undefined, latest)?.stats ?? emptyStats();
    sessionStats = await ledger.calculateStats(ledger.index.baseline, latest);
    updateWidget(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    draft = undefined;
    live = undefined;
    disabledReason = undefined;
    currentStats = emptyStats();
    sessionStats = emptyStats();
    ledger = new ChangedFilesLedger(pi, ctx.sessionManager.getSessionId(), ctx.cwd);
    viewer = new HunkHerdrViewer(
      pi,
      process.env.HERDR_WORKSPACE_ID,
      process.env.HERDR_TAB_ID,
      process.env.HERDR_PANE_ID,
      `Pi changes · ${ledger.sessionKey.slice(0, 8)}`,
    );
    initialized = ledger.initialize();
    try {
      await initialized;
      ctx.ui.setStatus(WIDGET_ID, undefined);
      live = ledger.index?.latest;
      nextTurnIndex = ledger.index?.turns.reduce(
        (next, turn) => Math.max(next, turn.turnIndex + 1),
        0,
      ) ?? 0;
      await refreshStats(ctx);
    } catch (error) {
      disabledReason = String(error);
      ctx.ui.notify(disabledReason, "warning");
      ctx.ui.setWidget(WIDGET_ID, undefined);
      updateDisabledStatus(ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    await initialized;
    if (!ledger || draft) return;
    draft = await ledger.beginTurn(nextTurnIndex, Date.now());
    nextTurnIndex += 1;
    live = draft.before;
    currentStats = emptyStats();
    updateWidget(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await initialized;
    if (!ledger || !draft) return;
    try {
      const record = await ledger.finishTurn(draft, Date.now());
      draft = undefined;
      live = record.after;
      currentStats = record.stats;
      sessionStats = await ledger.calculateStats(ledger.index!.baseline, record.after);
      pi.appendEntry(ENTRY_TYPE, {
        cacheKey: ledger.sessionKey,
        root: ledger.root,
        turnId: record.id,
        turnIndex: record.turnIndex,
        stats: record.stats,
      });
      updateWidget(ctx);
    } catch (error) {
      ctx.ui.notify(`Could not finalize changed-files turn: ${String(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    ctx.ui.setStatus(WIDGET_ID, undefined);
  });

  pi.registerCommand("diff", {
    description: "Review file changes in Hunk, or hide/show the ambient indicator",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "hide" || (action === "toggle" && !widgetHidden)) {
        widgetHidden = true;
        ctx.ui.setWidget(WIDGET_ID, undefined);
        ctx.ui.setStatus(WIDGET_ID, undefined);
        ctx.ui.notify("Changes indicator hidden. Use /diff show to restore it.", "info");
        return;
      }
      if (action === "show" || (action === "toggle" && widgetHidden)) {
        widgetHidden = false;
        if (disabledReason) {
          updateDisabledStatus(ctx);
        } else {
          updateWidget(ctx);
        }
        ctx.ui.notify("Changes indicator shown.", "info");
        return;
      }
      if (action && action !== "clear") {
        ctx.ui.notify("Usage: /diff [hide|show|toggle|clear]", "warning");
        return;
      }
      try {
        await initialized;
      } catch {
        ctx.ui.notify(disabledReason ?? "Changed-files ledger is unavailable", "warning");
        return;
      }
      if (!ledger?.index) {
        ctx.ui.notify("Changed-files ledger is unavailable", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/diff requires Pi's interactive TUI", "warning");
        return;
      }
      if (action === "clear") {
        if (draft) {
          ctx.ui.notify("Wait for the current agent run to finish before clearing diff history.", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear diff history?",
          "Use the current files as the new baseline and reset all turn and session counters?",
        );
        if (!confirmed) return;
        try {
          live = await ledger.resetBaseline();
          nextTurnIndex = 0;
          currentStats = emptyStats();
          sessionStats = emptyStats();
          updateWidget(ctx);
          ctx.ui.notify("Diff history cleared. Current files are now the session baseline.", "info");
        } catch (error) {
          ctx.ui.notify(`Could not clear diff history: ${String(error)}`, "error");
        }
        return;
      }
      try {
        const previousLatest = ledger.index.latest;
        live = await ledger.refreshLatest();
        const scopes = ledger.scopes(draft, live);
        const currentScope = scopes.find((scope) => scope.id === "current");
        if (draft && currentScope) {
          currentScope.stats = await ledger.calculateStats(currentScope.before, currentScope.after);
        }
        const sessionScope = scopes.find((scope) => scope.id === "session");
        if (sessionScope) {
          if (changedPaths(previousLatest, live).length > 0) {
            sessionStats = await ledger.calculateStats(sessionScope.before, sessionScope.after);
          }
          sessionScope.stats = sessionStats;
        }
        const visibleScopes = scopes.filter((scope) => scope.stats.files > 0);
        if (visibleScopes.length === 0) {
          currentStats = emptyStats();
          sessionStats = emptyStats();
          updateWidget(ctx);
          ctx.ui.notify("No file changes recorded for this session", "info");
          return;
        }
        const items: SelectItem[] = visibleScopes.map((scope) => ({
          value: scope.id,
          label: scope.label,
          description: formatStats(scope.stats),
        }));
        const selected = await ctx.ui.custom<ScopeSelection | null>((tui, theme, _keybindings, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Review changes in Hunk")), 1, 0));
          const list = new SelectList(items, Math.min(items.length, 12), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          list.onSelect = (item) => done({ scopeId: item.value, target: "pane" });
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new Text(
            theme.fg("dim", "↑↓/j k navigate • enter pane • alt+enter tab • esc cancel"),
            1,
            0,
          ));
          container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (matchesKey(data, Key.alt("enter"))) {
                const item = list.getSelectedItem();
                if (item) done({ scopeId: item.value, target: "tab" });
                return;
              }
              if (matchesKey(data, "k")) list.handleInput("\x1b[A");
              else if (matchesKey(data, "j")) list.handleInput("\x1b[B");
              else list.handleInput(data);
              tui.requestRender();
            },
          };
        });
        if (!selected) return;
        const scope = visibleScopes.find((candidate) => candidate.id === selected.scopeId);
        if (!scope) return;
        const patchPath = await ledger.writePatch(scope);
        if (!viewer?.available()) {
          ctx.ui.notify(`Patch ready at ${patchPath}, but Pi is not running inside Herdr`, "warning");
          return;
        }
        const opened = await viewer.openOrReuse(ledger.root, patchPath, selected.target);
        currentStats = scopes.find((candidate) => candidate.id === "current")?.stats ?? emptyStats();
        sessionStats = scopes.find((candidate) => candidate.id === "session")?.stats ?? emptyStats();
        updateWidget(ctx);
        ctx.ui.notify(
          `${opened.reused ? "Updated" : "Opened"} Hunk in focused ${opened.target} ${opened.target === "tab" ? opened.tabId : opened.paneId}: ${scope.label}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Could not open changes in Hunk: ${String(error)}`, "error");
      }
    },
  });

}
