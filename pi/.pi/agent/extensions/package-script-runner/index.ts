import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  discoverPackageScriptWorkspace,
  type PackageScript,
  type PackageScriptProject,
} from "./src/discovery.js";
import {
  processSignature,
  processSummary,
  ProjectScriptHerdrRunner,
  serviceSlotKey,
  workspaceServiceKey,
} from "./src/herdr.js";

const WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const SOURCE_TAB_ID = process.env.HERDR_TAB_ID;
const SOURCE_PANE_ID = process.env.HERDR_PANE_ID;

interface ProjectScript {
  project: PackageScriptProject;
  script: PackageScript;
}

type PickerAction = "run-service" | "run-adjacent" | "focus" | "restart" | "stop";

interface PickerResult extends ProjectScript {
  action: PickerAction;
}

function projectScriptDisplay(choice: ProjectScript): string {
  const ecosystem = choice.project.manifest === "composer.json" ? ":composer" : "";
  return `${choice.project.label}${ecosystem}/${choice.script.name}`;
}

function fuzzyScore(script: PackageScript, query: string): number | undefined {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;
  const name = script.name.toLocaleLowerCase();
  const searchable = `${name}\n${script.body.toLocaleLowerCase()}`;
  if (!terms.every((term) => searchable.includes(term))) return undefined;
  return terms.reduce((score, term) => {
    if (name === term) return score - 100;
    if (name.startsWith(term)) return score - 20;
    const index = name.indexOf(term);
    return score + (index >= 0 ? index : 50);
  }, 0);
}

export function filterScripts(scripts: readonly PackageScript[], query: string): PackageScript[] {
  return scripts
    .map((script, index) => ({ script, index, score: fuzzyScore(script, query) }))
    .filter((entry): entry is { script: PackageScript; index: number; score: number } => entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.script);
}

export function filterProjectScripts(projects: readonly PackageScriptProject[], query: string): ProjectScript[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return projects
    .flatMap((project) => project.scripts.map((script) => ({ project, script })))
    .map((choice, index) => {
      let score = 0;
      for (const term of terms) {
        const projectSearch = `${choice.project.label} ${choice.project.manager} ${choice.project.manifest}`.toLocaleLowerCase();
        const projectIndex = projectSearch.indexOf(term);
        if (projectIndex >= 0) {
          score += projectIndex - 30;
          continue;
        }
        const scriptScore = fuzzyScore(choice.script, term);
        if (scriptScore === undefined) return { choice, index, score: undefined };
        score += scriptScore;
      }
      return { choice, index, score };
    })
    .filter((entry): entry is { choice: ProjectScript; index: number; score: number } => entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.choice);
}

export function orderProjectScripts(
  choices: readonly ProjectScript[],
  runningServices: ReadonlySet<string>,
  runningFirst: boolean,
): ProjectScript[] {
  if (!runningFirst) return [...choices];
  return choices
    .map((choice, index) => ({
      choice,
      index,
      running: runningServices.has(serviceSlotKey(choice.project.root, choice.script.invocation)),
    }))
    .sort((left, right) => Number(right.running) - Number(left.running) || left.index - right.index)
    .map((entry) => entry.choice);
}

class ScriptPicker implements Focusable {
  focused = false;
  private query = "";
  private selected = 0;
  private searchMode = false;
  private runningFirst = true;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly projects: PackageScriptProject[],
    private readonly runningServices: ReadonlySet<string>,
    private readonly maxVisible: number,
    private readonly done: (result: PickerResult | undefined) => void,
  ) {}

  handleInput(data: string): void {
    const scripts = this.filtered();
    if (this.searchMode) {
      if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+g")) {
        this.searchMode = false;
      } else if (matchesKey(data, Key.up)) {
        this.move(-1, scripts.length);
      } else if (matchesKey(data, Key.down)) {
        this.move(1, scripts.length);
      } else if (matchesKey(data, Key.pageUp)) {
        this.selected = Math.max(0, this.selected - this.maxVisible);
      } else if (matchesKey(data, Key.pageDown)) {
        this.selected = Math.min(Math.max(0, scripts.length - 1), this.selected + this.maxVisible);
      } else if (matchesKey(data, Key.alt("enter"))) {
        this.finish("run-adjacent", scripts);
        return;
      } else if (matchesKey(data, Key.enter)) {
        this.finishDefault(scripts);
        return;
      } else if (matchesKey(data, Key.backspace)) {
        this.query = [...this.query].slice(0, -1).join("");
        this.selected = 0;
      } else if (matchesKey(data, "ctrl+u")) {
        this.query = "";
        this.selected = 0;
      } else if ([...data].every((character) => character >= " " && character !== "\x7f")) {
        this.query += data;
        this.selected = 0;
      } else return;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "s")) {
      this.searchMode = true;
    } else if (matchesKey(data, "o")) {
      this.runningFirst = !this.runningFirst;
      this.selected = 0;
    } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.move(-1, scripts.length);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.move(1, scripts.length);
    } else if (matchesKey(data, Key.pageUp)) {
      this.selected = Math.max(0, this.selected - this.maxVisible);
    } else if (matchesKey(data, Key.pageDown)) {
      this.selected = Math.min(Math.max(0, scripts.length - 1), this.selected + this.maxVisible);
    } else if (matchesKey(data, Key.alt("enter"))) {
      this.finish("run-adjacent", scripts);
      return;
    } else if (matchesKey(data, Key.enter)) {
      this.finishDefault(scripts);
      return;
    } else {
      const selected = scripts[this.selected];
      const running = selected && this.isRunning(selected);
      if (running && matchesKey(data, "f")) this.finish("focus", scripts);
      else if (running && matchesKey(data, "r")) this.finish("restart", scripts);
      else if (running && matchesKey(data, "x")) this.finish("stop", scripts);
      else return;
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 20) return [truncateToWidth(this.theme.fg("accent", "project scripts"), Math.max(1, width), "")];
    const safeWidth = width;
    const innerWidth = safeWidth - 2;
    const scripts = this.filtered();
    this.selected = Math.min(this.selected, Math.max(0, scripts.length - 1));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), scripts.length - this.maxVisible));
    const visible = scripts.slice(start, start + this.maxVisible);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string) => {
      const clipped = truncateToWidth(content, innerWidth - 2, "");
      return border("│") + " " + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped) - 1)) + border("│");
    };
    const separator = border(`├${"─".repeat(innerWidth)}┤`);
    const managers = [...new Set(this.projects.map((project) => project.manager))].join("/");
    const title = this.theme.fg("accent", this.theme.bold(` project scripts · ${managers} `));
    const top = border("╭─") + title + border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1))}╮`);
    const cursor = this.focused && this.searchMode ? CURSOR_MARKER : "";
    const query = this.query || this.theme.fg("dim", this.searchMode ? "type to filter" : "press s to search");
    const mode = this.searchMode ? this.theme.fg("accent", "SEARCH") : this.theme.fg("muted", "BROWSE");
    const order = this.runningFirst ? "running first" : "manifest order";
    const lines = [
      top,
      row(`${mode}  ${this.theme.fg("muted", "Query:")} ${query}${cursor}${this.searchMode ? this.theme.fg("accent", "▏") : ""}`),
      row(this.theme.fg("dim", `Order: ${order} · o toggles`)),
      separator,
    ];

    if (visible.length === 0) {
      lines.push(row(this.theme.fg("warning", "No matching scripts")));
    } else {
      for (let index = 0; index < visible.length; index += 1) {
        const choice = visible[index]!;
        const absoluteIndex = start + index;
        const selected = absoluteIndex === this.selected;
        const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
        const ecosystem = choice.project.manifest === "composer.json" ? ":composer" : "";
        const project = this.theme.fg(selected ? "accent" : "muted", `${choice.project.label}${ecosystem}/`);
        const name = selected ? this.theme.fg("accent", this.theme.bold(choice.script.name)) : choice.script.name;
        const invocation = this.theme.fg(selected ? "text" : "muted", choice.script.invocation);
        const slot = serviceSlotKey(choice.project.root, choice.script.invocation);
        const status = this.runningServices.has(slot) ? this.theme.fg("success", "  ● running") : "";
        lines.push(row(`${prefix}${project}${name}  ${invocation}${status}`));
      }
    }

    const selectedChoice = scripts[this.selected];
    lines.push(separator);
    if (selectedChoice) {
      const commandPrefix = this.theme.fg("muted", "Command: ");
      const commandWidth = Math.max(1, innerWidth - 2 - visibleWidth(commandPrefix));
      const wrappedCommand = wrapTextWithAnsi(this.theme.fg("accent", selectedChoice.script.command), commandWidth);
      for (let index = 0; index < wrappedCommand.length; index += 1) {
        lines.push(row(`${index === 0 ? commandPrefix : " ".repeat(visibleWidth(commandPrefix))}${wrappedCommand[index] ?? ""}`));
      }
      const scriptPrefix = this.theme.fg("muted", "Script:  ");
      const bodyWidth = Math.max(1, innerWidth - 2 - visibleWidth(scriptPrefix));
      const wrappedBody = wrapTextWithAnsi(selectedChoice.script.body, bodyWidth);
      for (let index = 0; index < Math.min(2, wrappedBody.length); index += 1) {
        lines.push(row(`${index === 0 ? scriptPrefix : " ".repeat(visibleWidth(scriptPrefix))}${wrappedBody[index] ?? ""}`));
      }
    }
    lines.push(separator);
    const hovered = scripts[this.selected];
    if (this.searchMode) {
      lines.push(row(this.theme.fg("dim", "↑↓ navigate · Esc/Ctrl+G leave search · Enter run · Alt+Enter adjacent")));
    } else {
      lines.push(row(this.theme.fg("dim", "j/k or ↑↓ navigate · s search · o order · q/Esc cancel")));
      lines.push(row(this.theme.fg("dim", hovered && this.isRunning(hovered)
        ? "Running: f focus · r restart · x stop · Enter focus · Alt+Enter adjacent"
        : "Enter start service · Alt+Enter adjacent")));
    }
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}

  private move(delta: number, count: number): void {
    this.selected = count === 0 ? 0 : (this.selected + delta + count) % count;
  }

  private finish(action: PickerAction, scripts: readonly ProjectScript[]): void {
    const choice = scripts[this.selected];
    if (choice) this.done({ ...choice, action });
  }

  private finishDefault(scripts: readonly ProjectScript[]): void {
    const choice = scripts[this.selected];
    if (!choice) return;
    this.done({ ...choice, action: this.isRunning(choice) ? "focus" : "run-service" });
  }

  private isRunning(choice: ProjectScript): boolean {
    return this.runningServices.has(serviceSlotKey(choice.project.root, choice.script.invocation));
  }

  private filtered(): ProjectScript[] {
    return orderProjectScripts(filterProjectScripts(this.projects, this.query), this.runningServices, this.runningFirst);
  }
}

async function pickScript(
  ctx: ExtensionCommandContext,
  projects: PackageScriptProject[],
  runningServices: ReadonlySet<string>,
): Promise<PickerResult | undefined> {
  return ctx.ui.custom<PickerResult | undefined>(
    (tui, theme, _keybindings, done) => new ScriptPicker(
      tui,
      theme,
      projects,
      runningServices,
      Math.max(3, Math.min(10, tui.terminal.rows - 12)),
      done,
    ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 88, minWidth: 48, maxHeight: "85%", margin: 2 },
    },
  );
}

async function launchSelection(
  ctx: ExtensionCommandContext,
  runner: ProjectScriptHerdrRunner,
  selection: PickerResult,
): Promise<void> {
  const service = {
    key: serviceSlotKey(selection.project.root, selection.script.invocation),
    display: projectScriptDisplay(selection),
  };
  if (selection.action === "run-adjacent") {
    const target = await runner.target(selection.project.root, "pane");
    const running = await runner.settledProcesses(target);
    if (running.length > 0) {
      const choice = await ctx.ui.select(
        [
          "The adjacent runner is already busy.",
          `Running: ${processSummary(running)}`,
          `Selected command: ${selection.script.command}`,
          "Nothing will be stopped automatically.",
        ].join("\n"),
        ["Focus running process", "Stop it and run selected script", "Cancel"],
      );
      if (choice === "Focus running process") {
        await runner.focus(target);
        return;
      }
      if (choice !== "Stop it and run selected script") return;
      await runner.interrupt(target, processSignature(running));
    }
    await runner.run(target, selection.script.command);
    ctx.ui.notify(`Running in focused adjacent pane: ${selection.script.command}`, "info");
    return;
  }

  const target = await runner.target(selection.project.root, "service", service);
  const running = await runner.settledProcesses(target);
  if (selection.action === "focus") {
    if (running.length === 0) ctx.ui.notify(`Service is no longer running: ${service.display}`, "info");
    else await runner.focus(target);
    return;
  }
  if (selection.action === "stop") {
    if (running.length === 0) ctx.ui.notify(`Service is already stopped: ${service.display}`, "info");
    else {
      await runner.interrupt(target, processSignature(running));
      ctx.ui.notify(`Stopped service: ${service.display}`, "info");
    }
    return;
  }
  if (selection.action === "restart" && running.length > 0) {
    await runner.interrupt(target, processSignature(running));
  } else if (selection.action === "run-service" && running.length > 0) {
    await runner.focus(target);
    ctx.ui.notify(`Service started while the picker was open; focused it instead: ${service.display}`, "info");
    return;
  }

  await runner.run(target, selection.script.command);
  ctx.ui.notify(`Running service ${service.display}: ${selection.script.command}`, "info");
}

export default function packageScriptRunner(pi: ExtensionAPI) {
  pi.registerCommand("scripts", {
    description: "Search package.json and Composer scripts; run a service or adjacent command",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/scripts requires Pi's interactive TUI", "warning");
        return;
      }

      try {
        const workspace = await discoverPackageScriptWorkspace(ctx.cwd);
        if (workspace.projects.length === 0) {
          ctx.ui.notify("No package.json or composer.json found in the current project or immediate child Git repositories", "warning");
          return;
        }
        if (workspace.projects.every((project) => project.scripts.length === 0)) {
          ctx.ui.notify("Discovered package.json/composer.json files have no scripts", "info");
          return;
        }

        const tabLabel = `Project services · ${basename(workspace.root)} · ${workspaceServiceKey(workspace.root)}`;
        const runner = new ProjectScriptHerdrRunner(pi, WORKSPACE_ID, SOURCE_TAB_ID, SOURCE_PANE_ID, tabLabel);
        if (!runner.available()) {
          ctx.ui.notify("Project scripts require Pi to run inside Herdr", "warning");
          return;
        }

        const services = workspace.projects.flatMap((project) => project.scripts.map((script) => ({
          key: serviceSlotKey(project.root, script.invocation),
          display: projectScriptDisplay({ project, script }),
        })));
        const runningServices = await runner.runningServiceKeys(services);
        const selection = await pickScript(ctx, workspace.projects, runningServices);
        if (!selection) return;
        await launchSelection(ctx, runner, selection);
      } catch (error) {
        ctx.ui.notify(`Project scripts: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
