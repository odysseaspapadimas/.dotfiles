import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const singleLine = (text: string) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
const tokens = (n: number) => n < 1_000 ? `${n}` : n < 10_000 ? `${(n / 1_000).toFixed(1)}k`
  : n < 1_000_000 ? `${Math.round(n / 1_000)}k` : n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : `${Math.round(n / 1_000_000)}M`;

function columns(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const clippedLeft = truncateToWidth(left, width, "…");
  const available = width - visibleWidth(clippedLeft) - 2;
  if (!right || available <= 0) return clippedLeft;
  const clippedRight = truncateToWidth(right, available, "…");
  return clippedLeft + " ".repeat(width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)) + clippedRight;
}

export default function cleanFooter(pi: ExtensionAPI) {
  let enabled = true;
  let activeFooter: { refresh(): void; dispose(): void } | undefined;

  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      let disposed = false;
      let fetchingGit = false;
      let gitCounts: { added: number; modified: number; deleted: number; conflicts: number } | undefined;
      const abort = new AbortController();
      const refreshGit = async () => {
        if (disposed || fetchingGit) return;
        fetchingGit = true;
        try {
          const result = await pi.exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            { cwd: ctx.cwd, timeout: 5_000, signal: abort.signal });
          if (disposed) return;
          gitCounts = undefined;
          if (result.code === 0 && !result.killed) {
            const counts = { added: 0, modified: 0, deleted: 0, conflicts: 0 };
            const records = result.stdout.split("\0");
            for (let i = 0; i < records.length; i++) {
              if (!records[i]) continue;
              const status = records[i].slice(0, 2);
              if (status.includes("U") || status === "AA" || status === "DD") counts.conflicts++;
              else if (status.includes("D")) counts.deleted++;
              else if (status === "??" || status.includes("A")) counts.added++;
              else counts.modified++;
              // In NUL-delimited porcelain, a rename/copy has a second path record.
              if (status.includes("R") || status.includes("C")) i++;
            }
            gitCounts = counts;
          }
          tui.requestRender();
        } catch {
          if (!disposed) { gitCounts = undefined; tui.requestRender(); }
        } finally {
          fetchingGit = false;
        }
      };
      const refresh = () => { if (!disposed) { tui.requestRender(); void refreshGit(); } };
      const unsubscribe = footerData.onBranchChange(refresh);
      // No work in render(), no animation: modest polling also catches external git changes.
      const timer = setInterval(refresh, 15_000);
      timer.unref();
      const handle = {
        refresh,
        dispose() {
          if (disposed) return;
          disposed = true;
          clearInterval(timer);
          abort.abort();
          unsubscribe();
          if (activeFooter === handle) activeFooter = undefined;
        },
      };
      activeFooter = handle;
      void refreshGit();
      const created = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");
      const startedAt = Number.isFinite(created) ? created : Date.now();
      let usageKey: string | undefined;
      let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      let cacheHit: number | undefined;
      let turns = 0;
      return {
        dispose: handle.dispose,
        invalidate() { usageKey = undefined; },
        render(width: number): string[] {
          const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b));
          if (width <= 0) return ["", "", ""];
          const separator = theme.fg("dim", " · ");
          const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}`;
          if (key !== usageKey) {
            totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
            cacheHit = undefined;
            turns = 0;
            const add = (usage: Usage) => {
              totals.input += usage.input;
              totals.output += usage.output;
              totals.cacheRead += usage.cacheRead;
              totals.cacheWrite += usage.cacheWrite;
              totals.cost += usage.cost.total;
            };
            // Match native cumulative accounting, including tools, compaction and other usage entries.
            for (const entry of ctx.sessionManager.getEntries()) {
              if (entry.type === "message" && entry.message.role === "user") turns++;
              if (entry.type === "usage") add(entry.usage);
              else if (entry.type === "message" && entry.message.role === "assistant") {
                const usage = entry.message.usage;
                add(usage);
                const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
                cacheHit = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
              } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
                add(entry.message.usage);
              } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
                add(entry.usage);
              }
            }
            usageKey = key;
          }

          const cwd = ctx.sessionManager.getCwd();
          const fromHome = relative(homedir(), cwd);
          const insideHome = fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
          let location = theme.fg("accent", singleLine(insideHome ? fromHome ? `~${sep}${fromHome}` : "~" : cwd));
          const branch = footerData.getGitBranch();
          if (branch) location += " " + theme.fg("success", `(${singleLine(branch)})`);
          if (gitCounts) {
            const changes: string[] = [];
            if (gitCounts.added) changes.push(theme.fg("success", `+${gitCounts.added}`));
            if (gitCounts.modified) changes.push(theme.fg("warning", `~${gitCounts.modified}`));
            if (gitCounts.deleted) changes.push(theme.fg("error", `−${gitCounts.deleted}`));
            if (gitCounts.conflicts) changes.push(theme.fg("error", `!${gitCounts.conflicts}`));
            location += " " + (changes.length ? changes.join(" ") : theme.fg("dim", "clean"));
          }
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) location += separator + theme.fg("muted", singleLine(sessionName));

          const parts: string[] = [];
          if (totals.input) parts.push(theme.fg("muted", `↑${tokens(totals.input)}`));
          if (totals.output) parts.push(theme.fg("accent", `↓${tokens(totals.output)}`));
          if (totals.cacheRead) parts.push(theme.fg("dim", `R${tokens(totals.cacheRead)}`));
          if (totals.cacheWrite) parts.push(theme.fg("dim", `W${tokens(totals.cacheWrite)}`));
          if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) {
            parts.push(theme.fg("muted", `CH${cacheHit.toFixed(1)}%`));
          }
          const model = ctx.model;
          const subscription = model && (model.provider === "kimi-coding" ||
            (ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true));
          if (totals.cost || subscription) parts.push(theme.fg("muted", `$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`));

          const usage = ctx.getContextUsage();
          const percent = usage?.percent;
          const known = typeof percent === "number" && Number.isFinite(percent);
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
          const auto = pi.getSettings().compaction?.enabled !== false ? " (auto)" : "";
          const context = `${known ? `${percent.toFixed(1)}%` : "?"}/${tokens(contextWindow)}${auto}`;
          const contextColor = known && percent > 90 ? "error" : known && percent > 70 ? "warning" : "success";
          const filled = known ? Math.round(Math.max(0, Math.min(100, percent)) / 20) : 0;
          const bar = theme.fg(contextColor, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(5 - filled));
          const contextText = (width >= 60 ? `${bar} ` : "") + theme.fg(contextColor, context);

          let modelText = theme.bold(theme.fg("accent", singleLine(model?.id ?? "no-model")));
          if (model?.reasoning) {
            const thinking = pi.getThinkingLevel();
            modelText += separator + theme.fg("muted", thinking === "off" ? "thinking off" : thinking);
          }
          const stats = parts.join(separator);
          if (model && footerData.getAvailableProviderCount() > 1) {
            const withProvider = theme.fg("dim", `(${singleLine(model.provider)}) `) + modelText;
            if (visibleWidth(location) + 2 + visibleWidth(withProvider) <= width) modelText = withProvider;
          }
          // Give the model and context their own right-aligned zones, preserving them on smaller terminals.
          const locationWidth = Math.max(Math.min(12, width), width - visibleWidth(modelText) - 2);
          const statsWidth = Math.max(0, width - visibleWidth(contextText) - 2);
          const lines = [
            columns(truncateToWidth(location, locationWidth, "…"), modelText, width),
            columns(truncateToWidth(stats, statsWidth, "…"), contextText, width),
          ];
          const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
          const elapsed = minutes < 60 ? `${minutes}m` : minutes < 1_440
            ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
            : `${Math.floor(minutes / 1_440)}d ${Math.floor(minutes % 1_440 / 60)}h`;
          const clock = theme.fg("muted", `${elapsed} · ${turns} ${turns === 1 ? "turn" : "turns"}`);
          const busy = !ctx.isIdle();
          const pet = busy ? theme.fg("accent", "(=^･ω･^=) working")
            : known && percent > 90 ? theme.fg("warning", "(=O.O=) crowded")
            : theme.fg("dim", "(=-.-=) zzz");
          const extras = clock + (width >= 100 ? separator + pet : "");
          const statusText = statuses.map(([, text]) => singleLine(text)).join(separator);
          const statusWidth = Math.max(0, width - visibleWidth(extras) - 2);
          lines.push(columns(truncateToWidth(statusText, statusWidth, "…"), extras, width));
          return lines;
        },
      };
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (enabled) install(ctx);
  });

  pi.on("agent_start", () => activeFooter?.refresh());
  pi.on("agent_end", () => activeFooter?.refresh());
  pi.on("session_shutdown", () => activeFooter?.dispose());

  pi.registerCommand("footer", {
    description: "Toggle the rich three-line footer / Pi's default footer",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      enabled = !enabled;
      if (enabled) install(ctx);
      else ctx.ui.setFooter(undefined);
      ctx.ui.notify(enabled ? "Rich footer enabled" : "Default footer restored", "info");
    },
  });
}
