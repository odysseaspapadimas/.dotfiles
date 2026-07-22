import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RunnerTargetKind = "pane" | "service";
export type FocusDirection = "left" | "right" | "up" | "down";

interface HerdrPane { pane_id: string; tab_id: string; label?: string }
interface HerdrTab { tab_id: string; label?: string }
interface Rect { x: number; y: number; width: number; height: number }
interface LayoutPane { pane_id: string; rect: Rect }
interface Layout { focused_pane_id?: string; panes: LayoutPane[] }

export interface ForegroundProcess {
  pid?: number;
  name?: string;
  cmdline?: string;
  argv?: string[];
}

export interface ServiceDescriptor {
  key: string;
  display: string;
}

export interface RunnerTarget {
  paneId: string;
  tabId: string;
  kind: RunnerTargetKind;
  direction?: FocusDirection;
  created: boolean;
  serviceKey?: string;
}

interface ExecResult { stdout: string; stderr: string; code: number }
type ExecAPI = Pick<ExtensionAPI, "exec">;

function parseJson<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

export function serviceSlotKey(root: string, invocation: string): string {
  return createHash("sha256").update(root).update("\0").update(invocation).digest("hex").slice(0, 12);
}

export function workspaceServiceKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 8);
}

export function foregroundProcesses(stdout: string): ForegroundProcess[] {
  const info = parseJson<{ result?: { process_info?: { shell_pid?: number; foreground_processes?: ForegroundProcess[] } } }>(stdout)
    ?.result?.process_info;
  if (!info) return [];
  return (info.foreground_processes ?? []).filter((process) => process.pid !== info.shell_pid);
}

export function processSignature(processes: readonly ForegroundProcess[]): string {
  return processes
    .map((process) => `${process.pid ?? "?"}:${process.cmdline ?? process.argv?.join(" ") ?? process.name ?? "unknown"}`)
    .join("\n");
}

export function processSummary(processes: readonly ForegroundProcess[]): string {
  return processes
    .map((process) => process.cmdline ?? process.argv?.join(" ") ?? process.name ?? `pid ${process.pid ?? "?"}`)
    .join("; ");
}

export class ProjectScriptHerdrRunner {
  private paneTarget: RunnerTarget | undefined;

  constructor(
    private readonly pi: ExecAPI,
    private readonly workspaceId: string | undefined,
    private readonly sourceTabId: string | undefined,
    private readonly sourcePaneId: string | undefined,
    private readonly servicesTabLabel: string,
  ) {}

  available(): boolean {
    return process.env.HERDR_ENV === "1" && Boolean(this.workspaceId && this.sourceTabId && this.sourcePaneId);
  }

  async target(root: string, kind: "pane"): Promise<RunnerTarget>;
  async target(root: string, kind: "service", service: ServiceDescriptor): Promise<RunnerTarget>;
  async target(root: string, kind: RunnerTargetKind, service?: ServiceDescriptor): Promise<RunnerTarget> {
    if (!this.available()) throw new Error("Pi is not running inside a Herdr workspace");
    if (kind === "pane") return (await this.findPaneTarget()) ?? this.createPane(root);
    if (!service) throw new Error("A service identity is required");
    return this.findOrCreateServiceTarget(root, service);
  }

  async runningServiceKeys(services: readonly ServiceDescriptor[]): Promise<Set<string>> {
    if (!this.available()) return new Set();
    const allPanes = await this.listPanes();
    const adopted: Array<{ pane: HerdrPane; service: ServiceDescriptor }> = [];
    const migratedTabs = new Set<string>();
    for (const service of services) {
      const legacyPrefix = `Project services · `;
      const legacyIdentity = ` · service · ${service.key} · `;
      const pane = allPanes.find((candidate) => {
        if (candidate.label?.startsWith(this.servicePanePrefix(service.key))) return true;
        if (!candidate.label?.startsWith(legacyPrefix)) return false;
        const beforeIdentity = candidate.label.slice(legacyPrefix.length).split(legacyIdentity)[0];
        return candidate.label.includes(legacyIdentity) && Boolean(beforeIdentity) && !beforeIdentity?.includes(" · ");
      });
      if (!pane) continue;
      if (!pane.label?.startsWith(this.servicePanePrefix(service.key))) {
        await this.exec("herdr", ["pane", "rename", pane.pane_id, this.servicePaneLabel(service)], 5_000);
        migratedTabs.add(pane.tab_id);
      }
      adopted.push({ pane, service });
    }
    for (const tabId of migratedTabs) {
      await this.exec("herdr", ["tab", "rename", tabId, this.servicesTabLabel], 5_000);
    }

    const running = new Set<string>();
    let keptIdlePane = false;
    for (const { pane, service } of adopted) {
      const target: RunnerTarget = { paneId: pane.pane_id, tabId: pane.tab_id, kind: "service", created: false };
      if ((await this.processes(target)).length === 0) {
        if (!keptIdlePane) keptIdlePane = true;
        else await this.pi.exec("herdr", ["pane", "close", pane.pane_id], { timeout: 5_000 }).catch(() => undefined);
        continue;
      }
      running.add(service.key);
    }
    return running;
  }

  async processes(target: RunnerTarget): Promise<ForegroundProcess[]> {
    const result = await this.exec("herdr", ["pane", "process-info", "--pane", target.paneId], 5_000);
    const info = parseJson<{ result?: { process_info?: { foreground_processes?: unknown } } }>(result.stdout)
      ?.result?.process_info;
    if (!info || !Array.isArray(info.foreground_processes)) {
      throw new Error("Herdr returned invalid process information; no script was launched");
    }
    return foregroundProcesses(result.stdout);
  }

  async settledProcesses(target: RunnerTarget, graceMs = 400): Promise<ForegroundProcess[]> {
    const deadline = Date.now() + graceMs;
    let idleSamples = 0;
    let latestBusy: ForegroundProcess[] = [];
    while (Date.now() < deadline) {
      const current = await this.processes(target);
      if (current.length === 0) {
        idleSamples += 1;
        if (idleSamples >= 2) return [];
      } else {
        idleSamples = 0;
        latestBusy = current;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return latestBusy;
  }

  async interrupt(target: RunnerTarget, expectedSignature: string): Promise<void> {
    const current = await this.processes(target);
    if (processSignature(current) !== expectedSignature) {
      throw new Error("The runner process changed while awaiting your decision; no process was interrupted");
    }
    if (current.length === 0) return;
    await this.exec("herdr", ["pane", "send-keys", target.paneId, "ctrl+c"], 5_000);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      if ((await this.processes(target)).length === 0) return;
    }
    throw new Error("The running process did not stop after Ctrl+C; no script was launched");
  }

  async run(target: RunnerTarget, command: string): Promise<void> {
    if (!await this.waitForStableIdle(target, 1_000, 2)) {
      throw new Error("The runner became busy before launch; no script was launched");
    }
    await this.focus(target);
    await this.exec("herdr", ["pane", "run", target.paneId, command], 10_000);
  }

  async focus(target: RunnerTarget): Promise<void> {
    await this.exec("herdr", ["tab", "focus", target.tabId], 5_000);
    if (target.kind === "service") {
      await this.focusServicePane(target);
      return;
    }
    const direction = target.direction ?? await this.directionBetween(this.sourcePaneId!, target.paneId) ?? "right";
    await this.exec("herdr", ["pane", "focus", "--direction", direction, "--pane", this.sourcePaneId!], 5_000);
  }

  private async findPaneTarget(): Promise<RunnerTarget | undefined> {
    const panes = await this.listPanes();
    const pane = (this.paneTarget && panes.find((candidate) => candidate.pane_id === this.paneTarget!.paneId))
      ?? panes.find((candidate) => candidate.tab_id === this.sourceTabId && candidate.label === this.paneLabel());
    if (!pane) return undefined;
    const target: RunnerTarget = {
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      kind: "pane",
      direction: await this.directionBetween(this.sourcePaneId!, pane.pane_id) ?? this.paneTarget?.direction ?? "right",
      created: false,
    };
    this.paneTarget = target;
    return target;
  }

  private async findOrCreateServiceTarget(root: string, service: ServiceDescriptor): Promise<RunnerTarget> {
    const panes = await this.listPanes();
    const exact = panes.find((candidate) => candidate.label?.startsWith(this.servicePanePrefix(service.key)));
    if (exact) return {
      paneId: exact.pane_id,
      tabId: exact.tab_id,
      kind: "service",
      created: false,
      serviceKey: service.key,
    };

    const servicePanes = panes.filter((candidate) => candidate.label?.startsWith(this.servicePaneBase()));
    for (const pane of servicePanes) {
      const candidate: RunnerTarget = {
        paneId: pane.pane_id,
        tabId: pane.tab_id,
        kind: "service",
        created: false,
      };
      if ((await this.processes(candidate)).length > 0) continue;
      await this.exec("herdr", ["pane", "rename", pane.pane_id, this.servicePaneLabel(service)], 5_000);
      return { ...candidate, serviceKey: service.key };
    }

    const serviceTab = await this.findServicesTab(panes);
    return serviceTab
      ? this.splitServicePane(serviceTab, root, service)
      : this.createServicesTab(root, service);
  }

  private async findServicesTab(panes: HerdrPane[]): Promise<{ tabId: string; anchorPaneId: string } | undefined> {
    const servicePane = panes.find((candidate) => candidate.label?.startsWith(this.servicePaneBase()));
    if (servicePane) return { tabId: servicePane.tab_id, anchorPaneId: servicePane.pane_id };
    const tabsResult = await this.exec("herdr", ["tab", "list", "--workspace", this.workspaceId!], 5_000);
    const tabs = parseJson<{ result?: { tabs?: HerdrTab[] } }>(tabsResult.stdout)?.result?.tabs;
    if (!Array.isArray(tabs)) throw new Error("Herdr returned an invalid tab list");
    const tab = tabs.find((candidate) => candidate.label === this.servicesTabLabel);
    if (!tab) return undefined;
    const inTab = panes.filter((candidate) => candidate.tab_id === tab.tab_id);
    if (inTab.length !== 1) throw new Error(`The existing ${this.servicesTabLabel} tab has no reusable service pane`);
    return { tabId: tab.tab_id, anchorPaneId: inTab[0]!.pane_id };
  }

  private async createPane(root: string): Promise<RunnerTarget> {
    const direction = await this.preferredSplitDirection(this.sourcePaneId!);
    const pane = await this.split(this.sourcePaneId!, direction, root);
    await this.renameOrClose(pane.pane_id, this.paneLabel());
    const target: RunnerTarget = { paneId: pane.pane_id, tabId: pane.tab_id, kind: "pane", direction, created: true };
    this.paneTarget = target;
    if (!await this.waitForStableIdle(target, 5_000, 3)) {
      throw new Error("The new runner pane did not finish shell initialization; no script was launched");
    }
    return target;
  }

  private async createServicesTab(root: string, service: ServiceDescriptor): Promise<RunnerTarget> {
    const result = await this.exec(
      "herdr",
      ["tab", "create", "--workspace", this.workspaceId!, "--cwd", root, "--label", this.servicesTabLabel, "--focus"],
      10_000,
    );
    const payload = parseJson<{ result?: { tab?: HerdrTab; pane?: HerdrPane; root_pane?: HerdrPane } }>(result.stdout);
    const tab = payload?.result?.tab;
    if (!tab) throw new Error("Herdr did not return the created services tab id");
    const pane = payload.result?.pane ?? payload.result?.root_pane
      ?? (await this.listPanes()).find((candidate) => candidate.tab_id === tab.tab_id);
    if (!pane) throw new Error(`Herdr tab ${tab.tab_id} has no pane`);
    await this.renameOrClose(pane.pane_id, this.servicePaneLabel(service));
    const target: RunnerTarget = {
      paneId: pane.pane_id,
      tabId: tab.tab_id,
      kind: "service",
      created: true,
      serviceKey: service.key,
    };
    if (!await this.waitForStableIdle(target, 5_000, 3)) {
      throw new Error("The new services tab did not finish shell initialization; no script was launched");
    }
    return target;
  }

  private async splitServicePane(
    tab: { tabId: string; anchorPaneId: string },
    root: string,
    service: ServiceDescriptor,
  ): Promise<RunnerTarget> {
    const direction = await this.preferredSplitDirection(tab.anchorPaneId);
    const pane = await this.split(tab.anchorPaneId, direction, root);
    await this.renameOrClose(pane.pane_id, this.servicePaneLabel(service));
    const target: RunnerTarget = {
      paneId: pane.pane_id,
      tabId: tab.tabId,
      kind: "service",
      created: true,
      serviceKey: service.key,
    };
    if (!await this.waitForStableIdle(target, 5_000, 3)) {
      throw new Error("The new service pane did not finish shell initialization; no script was launched");
    }
    return target;
  }

  private async split(anchorPaneId: string, direction: "right" | "down", root: string): Promise<HerdrPane> {
    const result = await this.exec(
      "herdr",
      ["pane", "split", anchorPaneId, "--direction", direction, "--cwd", root, "--focus"],
      10_000,
    );
    const pane = parseJson<{ result?: { pane?: HerdrPane } }>(result.stdout)?.result?.pane;
    if (!pane) throw new Error("Herdr did not return the created pane id");
    return pane;
  }

  private async renameOrClose(paneId: string, label: string): Promise<void> {
    try {
      await this.exec("herdr", ["pane", "rename", paneId, label], 5_000);
    } catch (error) {
      await this.pi.exec("herdr", ["pane", "close", paneId], { timeout: 5_000 }).catch(() => undefined);
      throw error;
    }
  }

  private async focusServicePane(target: RunnerTarget): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const layout = await this.layout(target.paneId);
      const current = layout?.focused_pane_id;
      if (!layout || !current || current === target.paneId) return;
      const direction = this.directionFromLayout(layout.panes, current, target.paneId);
      if (!direction) return;
      await this.exec("herdr", ["pane", "focus", "--direction", direction, "--pane", current], 5_000);
    }
  }

  private async waitForStableIdle(target: RunnerTarget, timeoutMs: number, requiredIdleSamples: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let idleSamples = 0;
    while (Date.now() < deadline) {
      if ((await this.processes(target)).length === 0) {
        idleSamples += 1;
        if (idleSamples >= requiredIdleSamples) return true;
      } else idleSamples = 0;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return false;
  }

  private async listPanes(): Promise<HerdrPane[]> {
    const result = await this.exec("herdr", ["pane", "list", "--workspace", this.workspaceId!], 5_000);
    const panes = parseJson<{ result?: { panes?: HerdrPane[] } }>(result.stdout)?.result?.panes;
    if (!Array.isArray(panes)) throw new Error("Herdr returned an invalid pane list");
    return panes;
  }

  private async preferredSplitDirection(paneId: string): Promise<"right" | "down"> {
    const layout = await this.layout(paneId);
    const pane = layout?.panes.find((entry) => entry.pane_id === paneId)?.rect;
    return pane && pane.width < pane.height * 2 ? "down" : "right";
  }

  private async directionBetween(sourcePaneId: string, targetPaneId: string): Promise<FocusDirection | undefined> {
    const layout = await this.layout(sourcePaneId);
    return layout ? this.directionFromLayout(layout.panes, sourcePaneId, targetPaneId) : undefined;
  }

  private directionFromLayout(
    panes: readonly LayoutPane[],
    sourcePaneId: string,
    targetPaneId: string,
  ): FocusDirection | undefined {
    const source = panes.find((entry) => entry.pane_id === sourcePaneId)?.rect;
    const target = panes.find((entry) => entry.pane_id === targetPaneId)?.rect;
    if (!source || !target) return undefined;
    const horizontal = Math.abs((target.x + target.width / 2) - (source.x + source.width / 2));
    const vertical = Math.abs((target.y + target.height / 2) - (source.y + source.height / 2));
    if (horizontal >= vertical) return target.x >= source.x ? "right" : "left";
    return target.y >= source.y ? "down" : "up";
  }

  private async layout(paneId: string): Promise<Layout | undefined> {
    const result = await this.exec("herdr", ["pane", "layout", "--pane", paneId], 5_000);
    const layout = parseJson<{ result?: { layout?: Layout } }>(result.stdout)?.result?.layout;
    return layout && Array.isArray(layout.panes) ? layout : undefined;
  }

  private paneLabel(): string {
    const source = this.sourcePaneId?.split(":").at(-1) ?? "unknown";
    return `${this.servicesTabLabel} · adjacent · ${source}`;
  }
  private servicePaneBase(): string { return `${this.servicesTabLabel} · service · `; }
  private servicePanePrefix(key: string): string { return `${this.servicePaneBase()}${key} · `; }
  private servicePaneLabel(service: ServiceDescriptor): string {
    return `${this.servicePanePrefix(service.key)}${service.display.slice(0, 80)}`;
  }

  private async exec(command: string, args: string[], timeout: number): Promise<ExecResult> {
    const result = await this.pi.exec(command, args, { timeout });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${command} ${args.slice(0, 2).join(" ")} failed`);
    return result;
  }
}
