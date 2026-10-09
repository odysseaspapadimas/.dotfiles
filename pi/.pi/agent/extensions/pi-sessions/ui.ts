import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { ManagedSession, SessionSnapshot } from "./store.ts";
import { runState } from "./runs.ts";

export type WorkerState = "running" | "blocked" | "failed" | "aborted" | "done" | "idle" | "stopped" | "multiple" | "unknown";
export interface WorkerRow {
  session: ManagedSession;
  state: WorkerState;
  preview: string;
  result?: string;
}
export interface SubagentSource {
  parentId(ctx: ExtensionContext): Promise<string | undefined>;
  rows(parentId: string, signal: AbortSignal): Promise<WorkerRow[]>;
  open(parentId: string, path: string, reopen: boolean, signal: AbortSignal): Promise<void>;
}
const colors = { running: "warning", blocked: "warning", failed: "error", aborted: "error", done: "success",
  idle: "muted", stopped: "dim", multiple: "error", unknown: "muted" } as const;
const glyphs = { running: "◐", blocked: "!", failed: "✗", aborted: "✗", done: "✓", idle: "○", stopped: "○", multiple: "!", unknown: "?" } as const;
const key = "pi-subagents";
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export function workerRow(snapshot: SessionSnapshot, runtimeStatus: string, outcome = runState(snapshot, runtimeStatus).outcome): WorkerRow {
  // Completion belongs to a task run, not the runtime. Reopening its history
  // leaves the old result completed but makes the live session available again.
  const state: WorkerState = runtimeStatus === "working" ? "running" : runtimeStatus === "blocked" ? "blocked" :
    runtimeStatus === "multiple" ? "multiple" : runtimeStatus === "unknown" ? "unknown" :
    outcome === "completed" ? runtimeStatus === "stopped" ? "done" : "idle" :
    outcome === "failed" ? "failed" : outcome === "aborted" ? "aborted" :
    runtimeStatus === "stopped" ? "stopped" : runtimeStatus === "idle" || runtimeStatus === "done" ? "idle" : "unknown";
  const latest = snapshot.messages.findLast((entry) => entry.role === "assistant");
  return { session: snapshot.session, state, preview: clean(latest?.text ?? "No assistant response yet.").slice(0, 300),
    result: latest ? clean(latest.text) : undefined };
}
export function widgetRows(rows: WorkerRow[]): WorkerRow[] {
  return rows.filter((row) => row.state !== "done" && row.state !== "stopped");
}
export function orderedRows(rows: WorkerRow[]): WorkerRow[] {
  return [...rows].sort((a, b) => Number(["done", "stopped"].includes(a.state)) - Number(["done", "stopped"].includes(b.state)) ||
    b.session.updatedAt - a.session.updatedAt);
}
export function frame(lines: string[], width: number, theme: Theme): string[] {
  if (width <= 0) return [];
  if (width < 4) return lines.map((line) => truncateToWidth(line, width));
  const inner = width - 4;
  const border = (text: string) => theme.fg("borderMuted", text);
  return [border(`╭${"─".repeat(width - 2)}╮`), ...lines.map((line) => {
    const text = truncateToWidth(line, inner);
    return border("│ ") + text + " ".repeat(inner - visibleWidth(text)) + border(" │");
  }), border(`╰${"─".repeat(width - 2)}╯`)];
}

/** One binding per foreground session; no resources are started at extension load. */
export function registerSubagentUI(pi: ExtensionAPI, source: SubagentSource) {
  interface Binding {
    ctx: ExtensionContext;
    parentId?: string;
    abort: AbortController;
    rows: WorkerRow[];
    loading?: Promise<void>;
    timer?: ReturnType<typeof setInterval>;
    repaint?: () => void;
    error?: string;
    hidden?: boolean;
  }
  let binding: Binding | undefined;
  const publish = (b: Binding) => {
    if (binding !== b || b.abort.signal.aborted) return;
    const active = widgetRows(b.rows);
    if (b.hidden || !active.length && !b.error) { b.ctx.ui.setWidget(key, undefined); b.repaint?.(); return; }
    b.ctx.ui.setWidget(key, (_tui, theme) => ({
      render(width) {
        const lines = [theme.fg("accent", "● Subagents")];
        const visible = active.slice(0, 6);
        visible.forEach((row, index) => lines.push(
          theme.fg("dim", index === visible.length - 1 && active.length <= 6 && !b.error ? "└─ " : "├─ ") +
          theme.fg(colors[row.state], glyphs[row.state]) + " " + clean(row.session.name).replace(/\n/g, " ") +
          theme.fg("dim", ` (${row.state})`),
        ));
        if (active.length > 6) lines.push(theme.fg("dim", `└─ +${active.length - 6} more · /subagents`));
        if (b.error) lines.push(theme.fg("warning", "└─ Status unavailable · /subagents to retry"));
        return [...lines, ""].map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
    b.repaint?.();
  };
  const refresh = (b = binding): Promise<void> => {
    if (!b || !b.parentId || b.abort.signal.aborted) return Promise.resolve();
    if (b.loading) return b.loading;
    b.loading = (async () => {
      try {
        const rows = await source.rows(b.parentId!, b.abort.signal);
        if (binding !== b || b.abort.signal.aborted) return;
        b.rows = orderedRows(rows);
        b.error = undefined;
      } catch (error) {
        if (binding !== b || b.abort.signal.aborted) return;
        b.error = clean(String(error));
      }
      publish(b);
    })().finally(() => { b.loading = undefined; });
    return b.loading;
  };
  const stop = () => {
    if (!binding) return;
    const old = binding;
    binding = undefined;
    old.abort.abort();
    if (old.timer) clearInterval(old.timer);
    old.ctx.ui.setWidget(key, undefined);
  };
  const start = async (ctx: ExtensionContext) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const b: Binding = { ctx, abort: new AbortController(), rows: [] };
    binding = b;
    try { b.parentId = await source.parentId(ctx); }
    catch { if (binding === b) stop(); return; }
    if (binding !== b || b.abort.signal.aborted || !b.parentId) return;
    await refresh(b);
    if (binding !== b || b.abort.signal.aborted) return;
    b.timer = setInterval(() => { void refresh(b); }, 3000);
    b.timer.unref();
  };

  pi.registerCommand("subagents-toggle", {
    description: "Hide/show the above-editor subagent tree without stopping workers",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/subagents-toggle requires TUI mode", "warning"); return; }
      if (!binding) await start(ctx);
      const b = binding;
      if (!b?.parentId || b.abort.signal.aborted) return;
      b.hidden = !b.hidden;
      publish(b);
    },
  });

  pi.registerCommand("subagents", {
    description: "Pick child sessions, inspect saved results, or reopen without prompting (j/k navigation)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/subagents requires TUI mode", "warning"); return; }
      if (!binding) await start(ctx);
      const b = binding;
      if (!b?.parentId) { ctx.ui.notify("No persistent parent session available", "warning"); return; }
      await refresh(b);
      if (b.abort.signal.aborted) return;
      const action = await ctx.ui.custom<{ path: string; reopen: boolean } | undefined>((tui, theme, kb, done) => {
        let list: SelectList;
        let detail: WorkerRow | undefined;
        let detailLayout: { row: WorkerRow; width: number; lines: string[] } | undefined;
        let scroll = 0;
        let viewport = 8;
        let maximumScroll = 0;
        let closed = false;
        const selected = () => b.rows.find((row) => row.session.sessionPath === list.getSelectedItem()?.value);
        const rebuild = () => {
          const previous = list?.getSelectedItem()?.value;
          list = new SelectList(b.rows.map((row) => ({ value: row.session.sessionPath,
            label: `${glyphs[row.state]} ${clean(row.session.name).replace(/\n/g, " ")}`,
            description: row.state === "done" ? "done · saved" : row.state,
          })), Math.max(1, Math.min(8, Math.floor(tui.terminal.rows * 0.85) - 12)), {
            selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("dim", text),
          });
          const index = b.rows.findIndex((row) => row.session.sessionPath === previous);
          list.setSelectedIndex(Math.max(0, index));
          list.onSelect = () => { detail = selected(); scroll = 0; };
          list.onCancel = () => { closed = true; done(undefined); };
        };
        rebuild();
        b.repaint = () => { if (!closed) { rebuild(); tui.requestRender(); } };
        return {
          render(width) {
            if (width <= 0) return [];
            const inner = Math.max(1, width >= 4 ? width - 4 : width);
            const lines = [theme.fg("accent", theme.bold("Subagents")), ""];
            if (detail) {
              if (detailLayout?.row !== detail || detailLayout.width !== inner) {
                detailLayout = { row: detail, width: inner, lines: wrapTextWithAnsi(detail.result || "No assistant response yet.", inner) };
              }
              const content = detailLayout.lines;
              viewport = Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 9);
              maximumScroll = Math.max(0, content.length - viewport);
              scroll = Math.min(scroll, maximumScroll);
              lines.push(truncateToWidth(clean(detail.session.name), inner), "", ...content.slice(scroll, scroll + viewport), "",
                theme.fg("dim", `${scroll + 1}–${Math.min(scroll + viewport, content.length)}/${content.length} · j/k scroll · esc back`));
            } else {
              if (b.error) lines.push(...wrapTextWithAnsi(theme.fg("warning", b.error.slice(0, 180)), inner));
              if (b.rows.length) lines.push(...list.render(inner));
              else lines.push(theme.fg("dim", "No child sessions yet."));
              const row = selected();
              lines.push("", theme.fg("borderMuted", "─".repeat(inner)));
              if (row) lines.push(...wrapTextWithAnsi(theme.fg("muted", row.preview), inner).slice(0, 2));
              lines.push("", theme.fg("dim", "j/k ↑↓ select · enter result · f focus"), theme.fg("dim", "r reopen + focus · esc close"));
            }
            return frame(lines, width, theme);
          },
          invalidate() { rebuild(); },
          handleInput(data) {
            if (detail) {
              if (kb.matches(data, "tui.select.cancel")) detail = undefined;
              else if (matchesKey(data, "j") || matchesKey(data, "down")) scroll = Math.min(maximumScroll, scroll + 1);
              else if (matchesKey(data, "k") || matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
            } else if (matchesKey(data, "f") || matchesKey(data, "r")) {
              const row = selected();
              if (row) { closed = true; done({ path: row.session.sessionPath, reopen: matchesKey(data, "r") }); }
            } else list.handleInput(matchesKey(data, "j") ? "\x1b[B" : matchesKey(data, "k") ? "\x1b[A" : data);
            tui.requestRender();
          },
          dispose() { closed = true; b.repaint = undefined; },
        };
      }, { overlay: true, overlayOptions: { width: 72, maxHeight: "85%", margin: 1 } });
      b.repaint = undefined;
      if (!action || b.abort.signal.aborted) return;
      try { await source.open(b.parentId, action.path, action.reopen, b.abort.signal); }
      catch (error) { if (!b.abort.signal.aborted) ctx.ui.notify(clean(String(error)), "error"); }
      await refresh(b);
    },
  });
  return { start, stop, refresh };
}
