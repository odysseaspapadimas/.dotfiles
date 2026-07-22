import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth, visibleWidth, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
  bundledHunkSkillPath,
  type HunkOpenTarget,
  HunkHerdrViewer,
} from "./src/herdr.js";
import {
  type Checkpoint,
  type CheckpointStorageReport,
  type DiffStats,
  type RecoveryHistoryReport,
  type RestoreTarget,
  type RollbackPreview,
  type Snapshot,
  type TurnRecord,
  type TurnSource,
  ChangedFilesLedger,
  changedPaths,
  emptyStats,
  formatRepositoryStats,
  formatStats,
} from "./src/ledger.js";

const WIDGET_ID = "changed-files-ledger";
const ENTRY_TYPE = "pi-changed-files-ledger-v1";
export const RESTORE_COMMANDS = ["rollback", "restore"] as const;
export const TURN_RESTORE_ACTIONS = ["Undo changes from this response", "Restore state after this response"] as const;
export const RESTORE_ACTIONS = ["Restore now", "Preview in Hunk", "Cancel"] as const;
const EXCERPT_LENGTH = 80;

type SessionEntryLike = {
  id?: string;
  type?: string;
  message?: { role?: string; content?: unknown };
};

export function normalizeUserExcerpt(content: unknown, limit = EXCERPT_LENGTH): string | undefined {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block): block is { type: "text"; text: string } => Boolean(block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string")).map((block) => block.text).join(" ")
      : "";
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= limit ? normalized : `${characters.slice(0, Math.max(1, limit - 1)).join("").trimEnd()}…`;
}

/** Find the causal user entry on the active branch, retaining only its id/excerpt. */
export function triggeringUserMessage(entries: readonly SessionEntryLike[]): TurnSource | undefined {
  let sawCustomTriggerCandidate = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "custom_message") {
      sawCustomTriggerCandidate = true;
      continue;
    }
    if (entry.type !== "message") continue;
    if (entry.message?.role === "assistant" && sawCustomTriggerCandidate) return undefined;
    if (entry.message?.role !== "user") continue;
    const excerpt = normalizeUserExcerpt(entry.message.content);
    return excerpt ? { ...(entry.id ? { entryId: entry.id } : {}), excerpt } : undefined;
  }
  return undefined;
}

export function quotedExcerpt(source: TurnSource): string {
  return `“${source.excerpt.replace(/[“”]/gu, '"')}”`;
}

export function turnSourceLabel(turn: TurnRecord): string {
  return turn.source ? quotedExcerpt(turn.source) : `Agent-work turn #${turn.turnIndex + 1}`;
}

export function formatRestorationAudit(restoration: { target: string; action: string; divergenceFiles: number; safetyCheckpoint: string; safetyLabel?: string }): string {
  const action = restoration.action === "undo" ? "Undid" : "Restored";
  const safety = restoration.safetyLabel ? `${restoration.safetyLabel} (${restoration.safetyCheckpoint})` : restoration.safetyCheckpoint;
  return `${action}: ${restoration.target}\nExternal/unrecorded divergence: ${restoration.divergenceFiles} tracked-scope file(s) · safety: ${safety}`;
}

interface TurnDraft {
  id: string;
  turnIndex: number;
  startedAt: string;
  before: Snapshot;
  source?: TurnSource;
}

interface ScopeSelection {
  scopeId: string;
  target: HunkOpenTarget;
}

export type TimelineItem =
  | { kind: "turn"; turn: TurnRecord }
  | { kind: "checkpoint"; checkpoint: Checkpoint };

export function formatTimelineAge(timestamp: string | number, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(timestamp).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatTimelineColumns(item: TimelineItem): { title: string; stats: string; age: string } {
  if (item.kind === "checkpoint") return {
    title: `${item.checkpoint.kind === "named" ? "◆ Named checkpoint" : "◇ Safety checkpoint"} · ${checkpointDisplayName(item.checkpoint)}`,
    stats: "",
    age: formatTimelineAge(item.checkpoint.createdAt),
  };
  return {
    title: item.turn.source ? quotedExcerpt(item.turn.source) : `Agent-work turn #${item.turn.turnIndex + 1}`,
    stats: formatStats(item.turn.stats),
    age: formatTimelineAge(item.turn.endedAt),
  };
}

export function formatTimelineItem(item: TimelineItem): { label: string; description: string } {
  if (item.kind === "checkpoint") {
    const time = new Date(item.checkpoint.createdAt).toLocaleString();
    const age = formatTimelineAge(item.checkpoint.createdAt);
    return {
      label: `${item.checkpoint.kind === "named" ? "◆ Named checkpoint" : "◇ Safety checkpoint"} · ${checkpointDisplayName(item.checkpoint)}${item.checkpoint.sourceLabel ? ` · ${time}` : ""} · ${age}`,
      description: item.checkpoint.sourceId ? `${time} · target ${item.checkpoint.sourceId}` : time,
    };
  }
  const age = formatTimelineAge(item.turn.endedAt);
  if (!item.turn.source) return {
    label: `Agent-work turn #${item.turn.turnIndex + 1} · ${age}`,
    description: `${new Date(item.turn.endedAt).toLocaleString()} · ${formatStats(item.turn.stats)}`,
  };
  return {
    label: `${quotedExcerpt(item.turn.source)} · ${formatStats(item.turn.stats)} · ${age}`,
    description: `Agent-work turn #${item.turn.turnIndex + 1} · ${new Date(item.turn.endedAt).toLocaleString()}`,
  };
}

export function checkpointDisplayName(checkpoint: Checkpoint): string {
  return checkpoint.name ?? checkpoint.sourceLabel ?? `safety ${checkpoint.id.slice(-12)}`;
}

export function checkpointActions(checkpoint: Checkpoint): string[] {
  return ["Restore checkpoint", ...(checkpoint.kind === "automatic" ? ["Promote to named checkpoint"] : []), "Delete checkpoint", "Cancel"];
}

export function parseCheckpointPromotion(args: string): { id: string; name?: string } | undefined {
  const match = args.trim().match(/^promote\s+(\S+)(?:\s+([\s\S]+))?$/u);
  if (!match?.[1]) return undefined;
  const name = match[2]?.trim();
  return { id: match[1], ...(name ? { name } : {}) };
}

export function formatRecoveryHistory(report: RecoveryHistoryReport): string {
  return `${report.agentTurns} agent-turn restoration target(s), ${report.restorationAudits} restoration audit(s). ${report.automaticCheckpoints} safety and ${report.namedCheckpoints} named checkpoint(s) are separate and retained.`;
}

export function recoveryPruneDisclosure(report: RecoveryHistoryReport): string {
  return `Delete ${report.agentTurns} agent-turn restoration target(s) and ${report.restorationAudits} restoration audit record(s). This cannot be undone. All ${report.automaticCheckpoints} safety and ${report.namedCheckpoints} named checkpoint(s) are preserved; diff review scopes are unchanged.`;
}

export function formatRestoreActionSummary(target: RestoreTarget, preview: RollbackPreview): string {
  const divergenceRepositories = preview.divergenceRepositoryStats ? formatRepositoryStats(preview.divergenceRepositoryStats) : "";
  const divergence = preview.divergence.files
    ? `External/unrecorded divergence: ${formatStats(preview.divergence)}${divergenceRepositories ? ` (${divergenceRepositories})` : ""} (included in restore and safety checkpoint).`
    : "External/unrecorded divergence: none detected.";
  const repositories = preview.scope.repositoryStats ? formatRepositoryStats(preview.scope.repositoryStats) : "";
  return [
    `Restore target: ${target.label}`,
    `Actual current → target: ${formatStats(preview.scope.stats)}`,
    ...(repositories ? [`Per repository: ${repositories}`] : []),
    divergence,
    "Scope: tracked and non-ignored untracked regular files/symlinks. Ignored files, submodule contents, directories, and special files are excluded.",
    "Safety: Restore now first captures an automatic checkpoint, then restores exactly, verifies, and records an audit marker.",
  ].join("\n");
}

export function hasVisibleChanges(current: DiffStats, session: DiffStats): boolean {
  return current.files > 0 || session.files > 0;
}

export function formatCheckpointStorage(report: CheckpointStorageReport): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = report.namedBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const size = unit === 0 ? String(value) : value.toFixed(1);
  return `${report.checkpoints} total (${report.named} named, ${report.automatic} safety) · ${size} ${units[unit]} named storage`;
}

export default function changedFilesLedgerExtension(pi: ExtensionAPI) {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { restoration?: { target: string; action: string; divergenceFiles: number; safetyCheckpoint: string; safetyLabel?: string } };
    if (!data.restoration) return undefined;
    const [summary, detail] = formatRestorationAudit(data.restoration).split("\n");
    return new Text(`${theme.fg("accent", theme.bold("↶ File restoration"))}\n${summary}\n${theme.fg("muted", detail ?? "")}`, 1, 0);
  });

  let ledger: ChangedFilesLedger | undefined;
  let viewer: HunkHerdrViewer | undefined;
  let draft: TurnDraft | undefined;
  let nextTurnIndex = 0;
  let live: Snapshot | undefined;
  let currentStats: DiffStats = emptyStats();
  let sessionStats: DiffStats = emptyStats();
  let currentRepositoryStats: Record<string, DiffStats> = {};
  let sessionRepositoryStats: Record<string, DiffStats> = {};
  let widgetHidden = false;
  let disabledReason: string | undefined;
  let pendingRestore: { target: RestoreTarget; preview: RollbackPreview } | undefined;
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
    if (widgetHidden || !hasVisibleChanges(currentStats, sessionStats)) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(WIDGET_ID, undefined);
      return;
    }
    const lines = [[
      formatWidgetStats(ctx, ledger?.workspaceKind === "multi" ? "workspace turn" : "turn", currentStats, "accent"),
      ctx.ui.theme.fg("dim", "│"),
      formatWidgetStats(ctx, ledger?.workspaceKind === "multi" ? "workspace session" : "session", sessionStats, "muted"),
    ].join(" ")];
    if (ledger?.workspaceKind === "multi") {
      for (const repository of ledger.repositories) {
        const turn = currentRepositoryStats[repository.name] ?? emptyStats();
        const session = sessionRepositoryStats[repository.name] ?? emptyStats();
        if (!hasVisibleChanges(turn, session)) continue;
        lines.push([
          formatWidgetStats(ctx, `${repository.name} turn`, turn, "accent"),
          ctx.ui.theme.fg("dim", "│"),
          formatWidgetStats(ctx, `${repository.name} session`, session, "muted"),
        ].join(" "));
      }
    }
    ctx.ui.setStatus(WIDGET_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  async function refreshStats(ctx: ExtensionContext): Promise<void> {
    await initialized;
    if (!ledger?.index) return;
    const latest = live ?? ledger.index.latest;
    if (draft) {
      const current = await ledger.calculateWorkspaceStats(draft.before, latest);
      currentStats = current.total;
      currentRepositoryStats = current.repositories;
    } else {
      const current = ledger.currentScope(undefined, latest);
      currentStats = current?.stats ?? emptyStats();
      currentRepositoryStats = current?.repositoryStats ?? {};
    }
    const session = await ledger.calculateWorkspaceStats(ledger.index.baseline, latest);
    sessionStats = session.total;
    sessionRepositoryStats = session.repositories;
    updateWidget(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    draft = undefined;
    live = undefined;
    disabledReason = undefined;
    pendingRestore = undefined;
    currentStats = emptyStats();
    sessionStats = emptyStats();
    currentRepositoryStats = {};
    sessionRepositoryStats = {};
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
      nextTurnIndex = ledger.index?.recoveryTurns.reduce(
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
    const source = triggeringUserMessage(ctx.sessionManager.getBranch() as SessionEntryLike[]);
    draft = await ledger.beginTurn(nextTurnIndex, Date.now(), source);
    nextTurnIndex += 1;
    live = draft.before;
    currentStats = emptyStats();
    currentRepositoryStats = {};
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
      currentRepositoryStats = record.repositoryStats ?? {};
      const session = await ledger.calculateWorkspaceStats(ledger.index!.baseline, record.after);
      sessionStats = session.total;
      sessionRepositoryStats = session.repositories;
      pi.appendEntry(ENTRY_TYPE, {
        cacheKey: ledger.sessionKey,
        root: ledger.root,
        turnId: record.id,
        turnIndex: record.turnIndex,
        stats: record.stats,
        repositoryStats: record.repositoryStats,
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

  async function ensureLedger(ctx: ExtensionContext): Promise<ChangedFilesLedger | undefined> {
    try {
      await initialized;
    } catch {
      ctx.ui.notify(disabledReason ?? "Changed-files ledger is unavailable", "warning");
      return undefined;
    }
    if (!ledger?.index) ctx.ui.notify("Changed-files ledger is unavailable", "warning");
    return ledger?.index ? ledger : undefined;
  }

  function timeline(activeLedger: ChangedFilesLedger): TimelineItem[] {
    return [
      ...activeLedger.genuineAgentTurns().map((turn): TimelineItem => ({ kind: "turn", turn })),
      ...activeLedger.listCheckpoints().map((checkpoint): TimelineItem => ({ kind: "checkpoint", checkpoint })),
    ].sort((a, b) => {
      const time = (item: TimelineItem) => item.kind === "turn" ? item.turn.endedAt : item.checkpoint.createdAt;
      return time(b).localeCompare(time(a));
    });
  }

  async function selectRestoreTarget(ctx: ExtensionContext, activeLedger: ChangedFilesLedger): Promise<{ target: RestoreTarget; open: HunkOpenTarget } | undefined> {
    const entries = timeline(activeLedger);
    if (!entries.length) {
      ctx.ui.notify("No retained agent-work turns or checkpoints available", "info");
      return undefined;
    }
    const options = entries.map((item) => ({ item, columns: formatTimelineColumns(item) }));
    const selected = await ctx.ui.custom<number | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Restore files — choose a retained state")), 1, 0));
      const ageWidth = Math.max(3, ...options.map((option) => visibleWidth(option.columns.age)));
      const statsWidth = Math.max(8, ...options.map((option) => visibleWidth(option.columns.stats)));
      const rowWidth = Math.max(24, tui.terminal.columns - 6);
      const titleWidth = Math.max(8, rowWidth - statsWidth - ageWidth - 6);
      const items: SelectItem[] = options.map((option, index) => {
        const title = truncateToWidth(option.columns.title, titleWidth, "…");
        const titlePadding = " ".repeat(Math.max(0, titleWidth - visibleWidth(title)));
        const statsPadding = " ".repeat(Math.max(0, statsWidth - visibleWidth(option.columns.stats)));
        const agePadding = " ".repeat(Math.max(0, ageWidth - visibleWidth(option.columns.age)));
        const raw = `${title}${titlePadding} · ${option.columns.stats}${statsPadding} · ${agePadding}${option.columns.age}`;
        const label = raw
          .replace(/\+\d+/gu, (value) => theme.fg("success", value))
          .replace(/−\d+/gu, (value) => theme.fg("error", value));
        return { value: String(index), label };
      });
      const list = new SelectList(items, Math.min(items.length, Math.max(8, tui.terminal.rows - 7)), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (selectedItem) => done(Number(selectedItem.value));
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓/j k navigate · Enter select · Esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "k")) list.handleInput("\x1b[A");
          else if (matchesKey(data, "j")) list.handleInput("\x1b[B");
          else list.handleInput(data);
          tui.requestRender();
        },
      };
    });
    const item = selected === null ? undefined : options[selected]?.item;
    if (!item) return undefined;
    if (item.kind === "checkpoint") return {
      target: { id: item.checkpoint.id, label: `checkpoint ${checkpointDisplayName(item.checkpoint)}`, action: "checkpoint", snapshot: item.checkpoint.snapshot },
      open: "pane",
    };
    const linked = Boolean(item.turn.source);
    const actions = linked ? [...TURN_RESTORE_ACTIONS] : ["Undo this turn", "Restore state after this turn"];
    const action = await ctx.ui.select(turnSourceLabel(item.turn), [...actions, "Cancel"]);
    const source = item.turn.source ? `response to ${quotedExcerpt(item.turn.source)}` : `agent-work turn #${item.turn.turnIndex + 1}`;
    if (action === actions[0]) return { target: { id: item.turn.id, label: `changes from ${source}`, action: "undo", snapshot: item.turn.before }, open: "pane" };
    if (action === actions[1]) return { target: { id: item.turn.id, label: `state after ${source}`, action: "after", snapshot: item.turn.after }, open: "pane" };
    return undefined;
  }

  async function previewAndRestore(ctx: ExtensionContext, target: RestoreTarget, open: HunkOpenTarget, existingPreview?: RollbackPreview): Promise<void> {
    const activeLedger = await ensureLedger(ctx);
    if (!activeLedger) return;
    if (draft) {
      ctx.ui.notify("Wait for the current agent run to finish before restoring files.", "warning");
      return;
    }
    const preview = existingPreview ?? await activeLedger.previewRestore(target);
    if (preview.scope.stats.files === 0) {
      pendingRestore = undefined;
      ctx.ui.notify(`No restore needed: current tracked-scope files already match ${target.label}.`, "info");
      return;
    }
    pendingRestore = { target, preview };
    const action = await ctx.ui.select(formatRestoreActionSummary(target, preview), [...RESTORE_ACTIONS]);
    if (action === "Preview in Hunk") {
      const patchPath = await activeLedger.writePatch(preview.scope);
      if (viewer?.available()) {
        const opened = await viewer.openOrReuse(activeLedger.root, patchPath, open);
        ctx.ui.notify(`Restore preview opened in focused Hunk ${opened.target}; no files changed. Return to Pi and run /restore (or Ctrl+X z) to resume this exact preview.`, "info");
      } else ctx.ui.notify(`Restore preview ready at ${patchPath}; no files changed. Run /restore to resume it. Hunk focus requires Pi inside Herdr.`, "warning");
      return;
    }
    if (action !== "Restore now") {
      pendingRestore = undefined;
      ctx.ui.notify("Restore cancelled; no files changed.", "info");
      return;
    }
    // Selecting Restore now is the sole UI confirmation boundary. The API token is
    // intentionally constructed only here; rollback still performs stale-preview checks.
    pendingRestore = undefined;
    const result = await activeLedger.rollback(preview, { confirmed: true }, nextTurnIndex++);
    live = result.turn.after;
    currentStats = result.turn.stats;
    currentRepositoryStats = result.turn.repositoryStats ?? {};
    const session = await activeLedger.calculateWorkspaceStats(activeLedger.index!.baseline, result.turn.after);
    sessionStats = session.total;
    sessionRepositoryStats = session.repositories;
    pi.appendEntry(ENTRY_TYPE, {
      cacheKey: activeLedger.sessionKey,
      root: activeLedger.root,
      turnId: result.turn.id,
      turnIndex: result.turn.turnIndex,
      stats: result.turn.stats,
      repositoryStats: result.turn.repositoryStats,
      restoration: { target: target.label, action: target.action, divergenceFiles: preview.divergence.files, safetyCheckpoint: result.safetyCheckpoint.id, safetyLabel: checkpointDisplayName(result.safetyCheckpoint) },
    });
    updateWidget(ctx);
    ctx.ui.notify(`Restore complete. Safety checkpoint: ${checkpointDisplayName(result.safetyCheckpoint)} (${result.safetyCheckpoint.id})`, "info");
  }

  async function promoteSafetyCheckpoint(ctx: ExtensionContext, activeLedger: ChangedFilesLedger, checkpoint: Checkpoint, suppliedName?: string): Promise<void> {
    if (checkpoint.kind !== "automatic") throw new Error(`Checkpoint is already named: ${checkpointDisplayName(checkpoint)}`);
    const label = suppliedName?.trim() || await ctx.ui.input("Named checkpoint label", "e.g. before refactor");
    if (!label?.trim()) return;
    const snapshotId = checkpoint.snapshot.id;
    const promoted = await activeLedger.promoteCheckpoint(checkpoint.id, label);
    const report = await activeLedger.checkpointStorageReport();
    const identity = snapshotId ? `snapshot ${snapshotId}` : "existing snapshot";
    ctx.ui.notify(`Promoted safety checkpoint in place: ${promoted.name} (${promoted.id}) · ${identity} · no snapshot/blob copy`, report.warning ? "warning" : "info");
    if (report.warning) ctx.ui.notify(`${formatCheckpointStorage(report)}; named checkpoints require explicit deletion.`, "warning");
  }

  pi.registerCommand("checkpoint", {
    description: "Create or promote a checkpoint: /checkpoint [label] | /checkpoint promote <safety-id> [name]",
    handler: async (args, ctx) => {
      const activeLedger = await ensureLedger(ctx);
      if (!activeLedger) return;
      if (draft) {
        ctx.ui.notify("Wait for the current agent run to finish before changing checkpoints.", "warning");
        return;
      }
      try {
        if (args.trim().startsWith("promote")) {
          const request = parseCheckpointPromotion(args);
          if (!request) { ctx.ui.notify("Usage: /checkpoint promote <safety-id> [name]", "warning"); return; }
          const checkpoint = activeLedger.checkpoint(request.id);
          if (!checkpoint) { ctx.ui.notify(`Safety checkpoint not found: ${request.id}`, "warning"); return; }
          await promoteSafetyCheckpoint(ctx, activeLedger, checkpoint, request.name);
          return;
        }
        const label = args.trim() || await ctx.ui.input("Checkpoint label", "e.g. before refactor");
        if (!label?.trim()) return;
        const checkpoint = await activeLedger.createCheckpoint("named", label);
        const report = await activeLedger.checkpointStorageReport();
        ctx.ui.notify(`Checkpoint created: ${checkpoint.name} (${checkpoint.id})`, report.warning ? "warning" : "info");
        if (report.warning) ctx.ui.notify(`${formatCheckpointStorage(report)}; named checkpoints require explicit deletion.`, "warning");
      } catch (error) {
        ctx.ui.notify(`Could not change checkpoint: ${String(error)}`, "error");
      }
    },
  });

  const restoreCommand = (command: "rollback" | "restore") => ({
    description: `Open file restoration timeline or undo latest agent work: /${command} [last|checkpoint]`,
    handler: async (args: string, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${command} requires Pi's interactive TUI`, "warning");
        return;
      }
      const activeLedger = await ensureLedger(ctx);
      if (!activeLedger) return;
      try {
        const requested = args.trim();
        if (!requested && pendingRestore) {
          const pending = pendingRestore;
          await previewAndRestore(ctx, pending.target, "pane", pending.preview);
          return;
        }
        let selection: { target: RestoreTarget; open: HunkOpenTarget } | undefined;
        if (requested === "last") {
          const turn = await activeLedger.latestEligibleTurn();
          if (turn) selection = { target: { id: turn.id, label: turn.source ? `changes from response to ${quotedExcerpt(turn.source)}` : `pre-state of agent-work turn #${turn.turnIndex + 1}`, action: "undo", snapshot: turn.before }, open: "pane" };
        } else if (requested) {
          const checkpoint = activeLedger.checkpoint(requested);
          if (checkpoint) selection = { target: { id: checkpoint.id, label: `checkpoint ${checkpointDisplayName(checkpoint)}`, action: "checkpoint", snapshot: checkpoint.snapshot }, open: "pane" };
        } else selection = await selectRestoreTarget(ctx, activeLedger);
        if (!selection) {
          ctx.ui.notify(requested === "last" ? "No eligible genuine agent-work turn to undo" : requested ? `Checkpoint not found: ${requested}` : "Restore cancelled", requested ? "warning" : "info");
          return;
        }
        await previewAndRestore(ctx, selection.target, selection.open);
      } catch (error) {
        ctx.ui.notify(`Could not restore: ${String(error)}`, "error");
      }
    },
  });
  for (const command of RESTORE_COMMANDS) pi.registerCommand(command, restoreCommand(command));

  pi.registerCommand("restore-history", {
    description: "Report or explicitly prune retained automatic turn restoration history",
    handler: async (args, ctx) => {
      const activeLedger = await ensureLedger(ctx);
      if (!activeLedger) return;
      const action = args.trim();
      const report = activeLedger.recoveryHistoryReport();
      if (!action || action === "status") {
        ctx.ui.notify(formatRecoveryHistory(report), "info");
        return;
      }
      if (action !== "prune") {
        ctx.ui.notify("Usage: /restore-history [status|prune]", "warning");
        return;
      }
      if (report.agentTurns + report.restorationAudits === 0) {
        ctx.ui.notify("No automatic turn restoration history to prune.", "info");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Prune turn restoration history?",
        recoveryPruneDisclosure(report),
      );
      if (!confirmed) return;
      const removed = await activeLedger.pruneRecoveryHistory();
      ctx.ui.notify(`Pruned ${removed.agentTurns} agent-turn restoration target(s) and ${removed.restorationAudits} audit record(s). Checkpoints and diff review scopes were preserved.`, "info");
    },
  });

  pi.registerCommand("checkpoints", {
    description: "List and manage checkpoints, pruning, and storage",
    handler: async (args, ctx) => {
      const activeLedger = await ensureLedger(ctx);
      if (!activeLedger) return;
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (action === "delete") {
          const id = rest.join(" ");
          if (!id) {
            ctx.ui.notify("Usage: /checkpoints delete <checkpoint>", "warning");
            return;
          }
          const checkpoint = activeLedger.checkpoint(id);
          if (!checkpoint) {
            ctx.ui.notify(`Checkpoint not found: ${id}`, "warning");
            return;
          }
          if (await ctx.ui.confirm("Delete checkpoint?", checkpointDisplayName(checkpoint))) {
            await activeLedger.deleteCheckpoint(checkpoint.id);
            ctx.ui.notify(`Deleted checkpoint: ${checkpointDisplayName(checkpoint)}`, "info");
          }
          return;
        }
        if (action === "prune") {
          const automatic = activeLedger.listCheckpoints().filter((item) => item.kind === "automatic");
          if (automatic.length === 0) {
            ctx.ui.notify("No automatic safety checkpoints to prune.", "info");
            return;
          }
          if (await ctx.ui.confirm("Prune safety checkpoints?", `Delete ${automatic.length} automatic checkpoints? Named checkpoints are preserved.`)) {
            for (const checkpoint of automatic) await activeLedger.deleteCheckpoint(checkpoint.id);
            ctx.ui.notify(`Pruned ${automatic.length} automatic safety checkpoints.`, "info");
          }
          return;
        }
        if (action === "storage") {
          const report = await activeLedger.checkpointStorageReport();
          ctx.ui.notify(formatCheckpointStorage(report), report.warning ? "warning" : "info");
          return;
        }
        if (action && action !== "list") {
          ctx.ui.notify("Usage: /checkpoints [list|storage|prune|delete <checkpoint>]", "warning");
          return;
        }
        const checkpoints = activeLedger.listCheckpoints();
        if (action === "list") {
          const report = await activeLedger.checkpointStorageReport();
          const lines = checkpoints.map((item) => `${item.id}\t${item.kind}\t${checkpointDisplayName(item)}\t${item.createdAt}`);
          ctx.ui.notify(lines.length ? `${lines.join("\n")}\n${formatCheckpointStorage(report)}` : "No checkpoints available", report.warning ? "warning" : "info");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Use /checkpoints list outside the interactive TUI", "warning");
          return;
        }
        const report = await activeLedger.checkpointStorageReport();
        const selected = await ctx.ui.select("Checkpoints", [
          ...checkpoints.map((item) => `${item.kind === "named" ? "●" : "○"} ${checkpointDisplayName(item)}`),
          `Storage · ${formatCheckpointStorage(report)}`,
          ...(report.automatic ? [`Prune ${report.automatic} safety checkpoints`] : []),
        ]);
        const index = selected ? checkpoints.findIndex((item) => selected.endsWith(checkpointDisplayName(item))) : -1;
        if (index >= 0) {
          const checkpoint = checkpoints[index]!;
          const operation = await ctx.ui.select(checkpointDisplayName(checkpoint), checkpointActions(checkpoint));
          if (operation === "Restore checkpoint") await previewAndRestore(ctx, { id: checkpoint.id, label: `checkpoint ${checkpointDisplayName(checkpoint)}`, action: "checkpoint", snapshot: checkpoint.snapshot }, "pane");
          else if (operation === "Promote to named checkpoint") await promoteSafetyCheckpoint(ctx, activeLedger, checkpoint);
          else if (operation === "Delete checkpoint" && await ctx.ui.confirm("Delete checkpoint?", checkpointDisplayName(checkpoint))) {
            await activeLedger.deleteCheckpoint(checkpoint.id);
            ctx.ui.notify(`Deleted checkpoint: ${checkpointDisplayName(checkpoint)}`, "info");
          }
        } else if (selected?.startsWith("Prune")) {
          const automatic = checkpoints.filter((item) => item.kind === "automatic");
          if (await ctx.ui.confirm("Prune safety checkpoints?", `Delete ${automatic.length} automatic checkpoints? Named checkpoints are preserved.`)) {
            for (const checkpoint of automatic) await activeLedger.deleteCheckpoint(checkpoint.id);
            ctx.ui.notify(`Pruned ${automatic.length} automatic safety checkpoints.`, "info");
          }
        } else if (selected?.startsWith("Storage")) {
          ctx.ui.notify(formatCheckpointStorage(report), report.warning ? "warning" : "info");
        }
      } catch (error) {
        ctx.ui.notify(`Could not manage checkpoints: ${String(error)}`, "error");
      }
    },
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
          ctx.ui.notify("Wait for the current agent run to finish before clearing diff review.", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear diff review?",
          "Use the current files as the new review baseline and reset visible turn scopes and counters? Retained turn restoration targets, restoration audits, and all named/safety checkpoints will be preserved.",
        );
        if (!confirmed) return;
        try {
          live = await ledger.resetBaseline();
          currentStats = emptyStats();
          sessionStats = emptyStats();
          currentRepositoryStats = {};
          sessionRepositoryStats = {};
          updateWidget(ctx);
          ctx.ui.notify("Diff review cleared. Current files are now the review baseline; retained restoration history and checkpoints were preserved.", "info");
        } catch (error) {
          ctx.ui.notify(`Could not clear diff review: ${String(error)}`, "error");
        }
        return;
      }
      try {
        const previousLatest = ledger.index.latest;
        live = await ledger.refreshLatest();
        const scopes = ledger.scopes(draft, live);
        const currentScope = scopes.find((scope) => scope.id === "current");
        if (draft && currentScope) {
          const calculated = await ledger.calculateWorkspaceStats(currentScope.before, currentScope.after);
          currentScope.stats = calculated.total;
          currentScope.repositoryStats = calculated.repositories;
        }
        const sessionScope = scopes.find((scope) => scope.id === "session");
        if (sessionScope) {
          if (changedPaths(previousLatest, live).length > 0) {
            const calculated = await ledger.calculateWorkspaceStats(sessionScope.before, sessionScope.after);
            sessionStats = calculated.total;
            sessionRepositoryStats = calculated.repositories;
          }
          sessionScope.stats = sessionStats;
          sessionScope.repositoryStats = sessionRepositoryStats;
        }
        const visibleScopes = scopes.filter((scope) => scope.stats.files > 0);
        if (visibleScopes.length === 0) {
          currentStats = emptyStats();
          sessionStats = emptyStats();
          currentRepositoryStats = {};
          sessionRepositoryStats = {};
          updateWidget(ctx);
          ctx.ui.notify("No file changes recorded for this session", "info");
          return;
        }
        const items: SelectItem[] = visibleScopes.map((scope) => ({
          value: scope.id,
          label: scope.label,
          description: [formatStats(scope.stats), scope.repositoryStats ? formatRepositoryStats(scope.repositoryStats) : ""].filter(Boolean).join(" · "),
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
        const selectedCurrent = scopes.find((candidate) => candidate.id === "current");
        const selectedSession = scopes.find((candidate) => candidate.id === "session");
        currentStats = selectedCurrent?.stats ?? emptyStats();
        currentRepositoryStats = selectedCurrent?.repositoryStats ?? {};
        sessionStats = selectedSession?.stats ?? emptyStats();
        sessionRepositoryStats = selectedSession?.repositoryStats ?? {};
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
