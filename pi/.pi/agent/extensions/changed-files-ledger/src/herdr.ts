import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label?: string;
}

interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label?: string;
}

interface TabListResponse {
  result?: { tabs?: HerdrTab[] };
}

interface PaneListResponse {
  result?: { panes?: HerdrPane[] };
}

interface TabCreateResponse {
  result?: { tab?: HerdrTab; pane?: HerdrPane };
}

interface PaneSplitResponse {
  result?: { pane?: HerdrPane };
}

interface PaneLayoutResponse {
  result?: {
    layout?: {
      panes?: Array<{
        pane_id: string;
        rect: { width: number; height: number };
      }>;
    };
  };
}

export type HunkOpenTarget = "pane" | "tab";

export interface HunkOpenResult {
  paneId: string;
  tabId: string;
  reused: boolean;
  target: HunkOpenTarget;
}

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const bundledHunkPath = process.env.PI_CHANGES_HUNK_BIN ?? join(process.env.HOME ?? "", ".local", "bin", "hunk");
export const bundledHunkSkillPath = join(extensionDir, "skills", "hunk-review", "SKILL.md");

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class HunkHerdrViewer {
  private tabTarget: { tabId: string; paneId: string } | undefined;
  private paneTarget: { tabId: string; paneId: string; direction: "right" | "down" } | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly workspaceId: string | undefined,
    private readonly sourceTabId: string | undefined,
    private readonly sourcePaneId: string | undefined,
    private readonly label: string,
  ) {}

  available(): boolean {
    return process.env.HERDR_ENV === "1" && Boolean(this.workspaceId && this.sourceTabId && this.sourcePaneId);
  }

  async openOrReuse(cwd: string, patchPath: string, target: HunkOpenTarget): Promise<HunkOpenResult> {
    if (!this.available()) throw new Error("Pi is not running inside a Herdr workspace");
    return target === "pane"
      ? this.openOrReusePane(cwd, patchPath)
      : this.openOrReuseTab(cwd, patchPath);
  }

  private async openOrReusePane(cwd: string, patchPath: string): Promise<HunkOpenResult> {
    const existing = await this.findExistingPane();
    if (existing) {
      this.paneTarget = existing;
      await this.restartHunk(existing.paneId, patchPath);
      await this.focusPaneTarget(existing);
      return { ...existing, reused: true, target: "pane" };
    }

    const direction = await this.preferredSplitDirection();
    const created = await this.pi.exec(
      "herdr",
      ["pane", "split", this.sourcePaneId!, "--direction", direction, "--cwd", cwd, "--focus"],
      { timeout: 10_000 },
    );
    if (created.code !== 0) throw new Error(created.stderr.trim() || "Could not split a Herdr pane");
    const pane = parseJson<PaneSplitResponse>(created.stdout)?.result?.pane;
    if (!pane) throw new Error("Herdr did not return the created pane id");
    await this.pi.exec("herdr", ["pane", "rename", pane.pane_id, `${this.label} · pane`], { timeout: 5_000 });
    this.paneTarget = { tabId: pane.tab_id, paneId: pane.pane_id, direction };
    await this.runHunk(pane.pane_id, patchPath);
    return { tabId: pane.tab_id, paneId: pane.pane_id, reused: false, target: "pane" };
  }

  private async openOrReuseTab(cwd: string, patchPath: string): Promise<HunkOpenResult> {
    const existing = await this.findExistingTab();
    if (existing) {
      this.tabTarget = { tabId: existing.tab_id, paneId: existing.pane_id };
      await this.restartHunk(existing.pane_id, patchPath);
      await this.focusTab(existing.tab_id);
      return { tabId: existing.tab_id, paneId: existing.pane_id, reused: true, target: "tab" };
    }

    const created = await this.pi.exec(
      "herdr",
      ["tab", "create", "--workspace", this.workspaceId!, "--cwd", cwd, "--label", this.label, "--focus"],
      { timeout: 10_000 },
    );
    if (created.code !== 0) throw new Error(created.stderr.trim() || "Could not create Herdr tab");
    const payload = parseJson<TabCreateResponse>(created.stdout);
    const tab = payload?.result?.tab;
    if (!tab) throw new Error("Herdr did not return the created tab id");
    const pane = payload.result?.pane ?? (await this.findPane(tab.tab_id));
    if (!pane) throw new Error(`Herdr tab ${tab.tab_id} has no pane`);
    this.tabTarget = { tabId: tab.tab_id, paneId: pane.pane_id };
    await this.runHunk(pane.pane_id, patchPath);
    return { tabId: tab.tab_id, paneId: pane.pane_id, reused: false, target: "tab" };
  }

  private async findExistingPane(): Promise<{ tabId: string; paneId: string; direction: "right" | "down" } | undefined> {
    const panes = await this.listPanes();
    const remembered = this.paneTarget
      ? panes.find((pane) => pane.pane_id === this.paneTarget!.paneId)
      : undefined;
    const pane = remembered ?? panes.find(
      (candidate) => candidate.tab_id === this.sourceTabId && candidate.label === `${this.label} · pane`,
    );
    if (!pane) return undefined;
    return {
      tabId: pane.tab_id,
      paneId: pane.pane_id,
      direction: this.paneTarget?.direction ?? "right",
    };
  }

  private async findExistingTab(): Promise<{ tab_id: string; pane_id: string } | undefined> {
    if (this.tabTarget) {
      const result = await this.pi.exec("herdr", ["tab", "get", this.tabTarget.tabId], { timeout: 5_000 });
      const parsed = parseJson<{ result?: { tab?: HerdrTab } }>(result.stdout);
      if (result.code === 0 && parsed?.result?.tab) {
        const pane = await this.findPane(this.tabTarget.tabId);
        if (pane) return { tab_id: this.tabTarget.tabId, pane_id: pane.pane_id };
      }
    }
    const result = await this.pi.exec("herdr", ["tab", "list", "--workspace", this.workspaceId!], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not list Herdr tabs");
    const tab = parseJson<TabListResponse>(result.stdout)?.result?.tabs?.find((candidate) => candidate.label === this.label);
    if (!tab) return undefined;
    const pane = await this.findPane(tab.tab_id);
    return pane ? { tab_id: tab.tab_id, pane_id: pane.pane_id } : undefined;
  }

  private async listPanes(): Promise<HerdrPane[]> {
    const result = await this.pi.exec("herdr", ["pane", "list", "--workspace", this.workspaceId!], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not list Herdr panes");
    return parseJson<PaneListResponse>(result.stdout)?.result?.panes ?? [];
  }

  private async findPane(tabId: string): Promise<HerdrPane | undefined> {
    return (await this.listPanes()).find((pane) => pane.tab_id === tabId);
  }

  private async preferredSplitDirection(): Promise<"right" | "down"> {
    const result = await this.pi.exec("herdr", ["pane", "layout", "--pane", this.sourcePaneId!], { timeout: 5_000 });
    const panes = parseJson<PaneLayoutResponse>(result.stdout)?.result?.layout?.panes;
    const source = panes?.find((pane) => pane.pane_id === this.sourcePaneId);
    if (!source) return "right";
    return source.rect.width >= source.rect.height * 2 ? "right" : "down";
  }

  private async focusPaneTarget(target: { tabId: string; direction: "right" | "down" }): Promise<void> {
    await this.focusTab(target.tabId);
    const result = await this.pi.exec(
      "herdr",
      ["pane", "focus", "--direction", target.direction, "--pane", this.sourcePaneId!],
      { timeout: 5_000 },
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not focus the Hunk pane");
  }

  private async focusTab(tabId: string): Promise<void> {
    const result = await this.pi.exec("herdr", ["tab", "focus", tabId], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not focus the Hunk tab");
  }

  private async restartHunk(paneId: string, patchPath: string): Promise<void> {
    const process = await this.pi.exec("herdr", ["pane", "process-info", "--pane", paneId], { timeout: 5_000 });
    if (/hunk(?:diff)?(?:\s|$)/i.test(process.stdout)) {
      await this.pi.exec("herdr", ["pane", "send-keys", paneId, "ctrl+c"], { timeout: 5_000 });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    await this.runHunk(paneId, patchPath);
  }

  private async runHunk(paneId: string, patchPath: string): Promise<void> {
    // This is deliberately launched in a user-facing Herdr pane. Agents must use
    // `hunk session ...` rather than invoking Hunk's interactive TUI from a tool call.
    const command = `${shellQuote(bundledHunkPath)} patch ${shellQuote(patchPath)} --watch`;
    const result = await this.pi.exec("herdr", ["pane", "run", paneId, command], { timeout: 10_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not launch Hunk in Herdr");
  }
}
