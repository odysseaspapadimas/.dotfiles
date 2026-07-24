import { access, mkdir, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const SOURCE_TAB_ID = process.env.HERDR_TAB_ID;
const SOURCE_PANE_ID = process.env.HERDR_PANE_ID;
const LABEL = "File viewer";
const MAX_OVERLAY_BYTES = 2 * 1024 * 1024;
const PLUGIN_ROOT = join(homedir(), ".local", "share", "pi-file-viewer");
const PLUGINS = [
  { name: "mini.nvim", url: "https://github.com/nvim-mini/mini.nvim.git", revision: "a35f08f63b73f0ffac045cd175fb2a22e167c39c", marker: "lua/mini/pick.lua" },
  { name: "neo-tree.nvim", url: "https://github.com/nvim-neo-tree/neo-tree.nvim.git", revision: "ebd66767191714e008ce73b769518a763ff31bdc", marker: "lua/neo-tree.lua", branch: "v3.x" },
  { name: "plenary.nvim", url: "https://github.com/nvim-lua/plenary.nvim.git", revision: "74b06c6c75e4eeb3108ec01852001636d85a932b", marker: "lua/plenary/init.lua" },
  { name: "nui.nvim", url: "https://github.com/MunifTanjim/nui.nvim.git", revision: "de740991c12411b663994b2860f1a4fd0937c130", marker: "lua/nui/init.lua" },
] as const;

type OpenTarget = "pane" | "tab";
interface Location { path: string; line?: number }
interface HerdrPane { pane_id: string; tab_id: string; label?: string }
interface HerdrTab { tab_id: string; label?: string }
interface ViewerTarget { paneId: string; tabId: string; socket: string; direction?: "right" | "down" }

function parseJson<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pickerCommand(root: string): string {
  return `lua MiniPick.builtin.files({ tool = "git" }, { source = { cwd = ${JSON.stringify(root)} } })`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function parseLocation(input: string): Location {
  const trimmed = input.trim();
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (!match || !match[1]) return { path: trimmed };
  return { path: match[1], line: Math.max(1, Number(match[2])) };
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
  return result.code === 0 ? realpath(result.stdout.trim()) : realpath(cwd);
}

async function ensureViewerPlugins(pi: ExtensionAPI): Promise<void> {
  await mkdir(PLUGIN_ROOT, { recursive: true });
  for (const plugin of PLUGINS) {
    const directory = join(PLUGIN_ROOT, plugin.name);
    try {
      await access(join(directory, plugin.marker));
      continue;
    } catch {}
    await rm(directory, { recursive: true, force: true });
    const args = ["clone", "--filter=blob:none"];
    if ("branch" in plugin) args.push("--branch", plugin.branch);
    args.push(plugin.url, directory);
    const clone = await pi.exec("git", args, { timeout: 60_000 });
    if (clone.code !== 0) throw new Error(clone.stderr.trim() || `Could not install ${plugin.name}`);
    const checkout = await pi.exec("git", ["-C", directory, "checkout", "--detach", plugin.revision], { timeout: 30_000 });
    if (checkout.code !== 0) throw new Error(checkout.stderr.trim() || `Could not pin ${plugin.name}`);
  }
}

async function resolveLocation(root: string, location: Location): Promise<Location> {
  if (!location.path) throw new Error("No file selected");
  const candidate = resolve(root, location.path);
  if (!inside(root, candidate)) throw new Error("File must be inside the project root");
  const canonical = await realpath(candidate);
  if (!inside(root, canonical)) throw new Error("File symlink resolves outside the project root");
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("Selection is not a regular file");
  return { path: canonical, line: location.line };
}

function socketPath(target: OpenTarget): string {
  const identity = `${WORKSPACE_ID ?? "none"}-${SOURCE_PANE_ID ?? process.pid}-${target}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(tmpdir(), `pi-view-${identity}.sock`);
}

class HerdrViewer {
  private paneTarget?: ViewerTarget;
  private tabTarget?: ViewerTarget;
  constructor(private pi: ExtensionAPI) {}

  available(): boolean {
    return process.env.HERDR_ENV === "1" && Boolean(WORKSPACE_ID && SOURCE_TAB_ID && SOURCE_PANE_ID);
  }

  async open(root: string, location: Location | undefined, target: OpenTarget): Promise<void> {
    const existing = target === "pane" ? await this.findPane() : await this.findTab();
    const viewer = existing ?? (target === "pane" ? await this.createPane(root) : await this.createTab(root));
    if (target === "pane") this.paneTarget = viewer; else this.tabTarget = viewer;

    if (await this.serverAvailable(viewer.socket)) {
      if (location) {
        const args = ["--server", viewer.socket, "--remote-silent"];
        if (location.line) args.push(`+${location.line}`);
        args.push(location.path);
        const remote = await this.pi.exec("nvim", args, { timeout: 5_000 });
        if (remote.code !== 0) throw new Error(remote.stderr.trim() || "Could not update Neovim viewer");
        await this.pi.exec("nvim", ["--server", viewer.socket, "--remote-send", "<Esc>:setlocal noreadonly modifiable<CR>"], { timeout: 2_000 });
      } else {
        const pick = await this.pi.exec("nvim", ["--server", viewer.socket, "--remote-send", `<Esc>:${pickerCommand(root)}<CR>`], { timeout: 5_000 });
        if (pick.code !== 0) throw new Error(pick.stderr.trim() || "Could not open mini.pick");
      }
    } else {
      await unlink(viewer.socket).catch(() => undefined);
      const command = [
        "nvim", "--listen", shellQuote(viewer.socket),
        location?.line ? `+${location.line}` : "",
        location ? shellQuote(location.path) : shellQuote(`+${pickerCommand(root)}`),
      ].filter(Boolean).join(" ");
      const run = await this.pi.exec("herdr", ["pane", "run", viewer.paneId, command], { timeout: 10_000 });
      if (run.code !== 0) throw new Error(run.stderr.trim() || "Could not launch Neovim viewer");
    }
    await this.focus(viewer, target);
  }

  private async serverAvailable(socket: string): Promise<boolean> {
    try {
      await access(socket);
      const result = await this.pi.exec("nvim", ["--server", socket, "--remote-expr", "1"], { timeout: 2_000 });
      return result.code === 0;
    } catch { return false; }
  }

  private async listPanes(): Promise<HerdrPane[]> {
    const result = await this.pi.exec("herdr", ["pane", "list", "--workspace", WORKSPACE_ID!], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not list Herdr panes");
    return parseJson<{ result?: { panes?: HerdrPane[] } }>(result.stdout)?.result?.panes ?? [];
  }

  private async findPane(): Promise<ViewerTarget | undefined> {
    const panes = await this.listPanes();
    const pane = (this.paneTarget && panes.find((item) => item.pane_id === this.paneTarget!.paneId))
      ?? panes.find((item) => item.tab_id === SOURCE_TAB_ID && item.label === `${LABEL} · pane`);
    return pane ? { paneId: pane.pane_id, tabId: pane.tab_id, socket: socketPath("pane"), direction: this.paneTarget?.direction ?? "right" } : undefined;
  }

  private async findTab(): Promise<ViewerTarget | undefined> {
    const tabsResult = await this.pi.exec("herdr", ["tab", "list", "--workspace", WORKSPACE_ID!], { timeout: 5_000 });
    if (tabsResult.code !== 0) throw new Error(tabsResult.stderr.trim() || "Could not list Herdr tabs");
    const tabs = parseJson<{ result?: { tabs?: HerdrTab[] } }>(tabsResult.stdout)?.result?.tabs ?? [];
    const tab = tabs.find((item) => item.label === LABEL);
    if (!tab) return undefined;
    const pane = (await this.listPanes()).find((item) => item.tab_id === tab.tab_id);
    return pane ? { paneId: pane.pane_id, tabId: tab.tab_id, socket: socketPath("tab") } : undefined;
  }

  private async direction(): Promise<"right" | "down"> {
    const result = await this.pi.exec("herdr", ["pane", "layout", "--pane", SOURCE_PANE_ID!], { timeout: 5_000 });
    const panes = parseJson<{ result?: { layout?: { panes?: Array<{ pane_id: string; rect: { width: number; height: number } }> } } }>(result.stdout)?.result?.layout?.panes;
    const source = panes?.find((item) => item.pane_id === SOURCE_PANE_ID);
    return source && source.rect.width < source.rect.height * 2 ? "down" : "right";
  }

  private async createPane(root: string): Promise<ViewerTarget> {
    const direction = await this.direction();
    const result = await this.pi.exec("herdr", ["pane", "split", SOURCE_PANE_ID!, "--direction", direction, "--cwd", root, "--focus"], { timeout: 10_000 });
    const pane = parseJson<{ result?: { pane?: HerdrPane } }>(result.stdout)?.result?.pane;
    if (result.code !== 0 || !pane) throw new Error(result.stderr.trim() || "Could not create viewer pane");
    await this.pi.exec("herdr", ["pane", "rename", pane.pane_id, `${LABEL} · pane`], { timeout: 5_000 });
    return { paneId: pane.pane_id, tabId: pane.tab_id, socket: socketPath("pane"), direction };
  }

  private async createTab(root: string): Promise<ViewerTarget> {
    const result = await this.pi.exec("herdr", ["tab", "create", "--workspace", WORKSPACE_ID!, "--cwd", root, "--label", LABEL, "--focus"], { timeout: 10_000 });
    const payload = parseJson<{ result?: { tab?: HerdrTab; pane?: HerdrPane } }>(result.stdout);
    if (result.code !== 0 || !payload?.result?.tab) throw new Error(result.stderr.trim() || "Could not create viewer tab");
    const pane = payload.result.pane ?? (await this.listPanes()).find((item) => item.tab_id === payload.result!.tab!.tab_id);
    if (!pane) throw new Error("Viewer tab has no pane");
    return { paneId: pane.pane_id, tabId: pane.tab_id, socket: socketPath("tab") };
  }

  private async focus(viewer: ViewerTarget, target: OpenTarget): Promise<void> {
    if (target === "tab") {
      await this.pi.exec("herdr", ["tab", "focus", viewer.tabId], { timeout: 5_000 });
      return;
    }
    await this.pi.exec("herdr", ["tab", "focus", viewer.tabId], { timeout: 5_000 });
    const result = await this.pi.exec("herdr", ["pane", "focus", "--direction", viewer.direction ?? "right", "--pane", SOURCE_PANE_ID!], { timeout: 5_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not focus viewer pane");
  }
}

function frame(theme: Theme, title: string, body: string[], footer: string, width: number): string[] {
  const inner = Math.max(20, width - 2);
  const border = (value: string) => theme.fg("border", value);
  const heading = theme.fg("accent", theme.bold(` ${title} `));
  const row = (value: string) => {
    const clipped = truncateToWidth(value, inner, "");
    return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
  };
  return [
    border("╭─") + heading + border("─".repeat(Math.max(0, inner - visibleWidth(heading) - 1)) + "╮"),
    ...body.map(row),
    border("├" + "─".repeat(inner) + "┤"),
    row(footer),
    border("╰" + "─".repeat(inner) + "╯"),
  ];
}

class OverlayViewer {
  private offset: number;
  constructor(private tui: TUI, private theme: Theme, private location: Location, private lines: string[], private done: () => void) {
    this.offset = Math.max(0, (location.line ?? 1) - 1);
  }
  handleInput(data: string): void {
    const page = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.done();
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.offset--;
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.offset++;
    else if (matchesKey(data, "pageUp")) this.offset -= page;
    else if (matchesKey(data, "pageDown")) this.offset += page;
    else if (matchesKey(data, "g")) this.offset = 0;
    else if (matchesKey(data, "shift+g")) this.offset = this.lines.length;
    this.offset = Math.max(0, this.offset);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const count = Math.max(1, Math.floor(this.tui.terminal.rows * 0.78) - 4);
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - count));
    const digits = String(this.lines.length).length;
    const body = this.lines.slice(this.offset, this.offset + count).map((line, index) =>
      this.theme.fg("dim", String(this.offset + index + 1).padStart(digits) + " │ ") + line.replaceAll("\t", "    "),
    );
    const footer = this.theme.fg("dim", `j/k · PgUp/PgDn · g/G · q close · ${this.offset + 1}-${Math.min(this.lines.length, this.offset + count)}/${this.lines.length}`);
    return frame(this.theme, basename(this.location.path), body, footer, width);
  }
  invalidate(): void {}
}

async function showOverlay(ctx: ExtensionCommandContext, location: Location): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("File overlay requires Pi's interactive TUI", "warning");
    return;
  }
  const info = await stat(location.path);
  if (info.size > MAX_OVERLAY_BYTES) throw new Error("File is too large for the Pi overlay (2 MiB limit)");
  const text = await readFile(location.path, "utf8");
  await ctx.ui.custom<void>((tui, theme, _kb, done) => new OverlayViewer(tui, theme, location, text.split("\n"), () => done()), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", minWidth: 48, maxHeight: "90%", margin: 1 },
  });
}

export default function fileViewer(pi: ExtensionAPI) {
  const viewer = new HerdrViewer(pi);
  pi.registerCommand("view", {
    description: "Open a project file in Neovim: /view [--tab] [path[:line]]",
    handler: async (args, ctx) => {
      try {
        const root = await gitRoot(pi, ctx.cwd);
        let target: OpenTarget = /^\s*--tab(?:\s|$)/.test(args) ? "tab" : "pane";
        const raw = args.replace(/^\s*--tab(?:\s+|$)/, "").trim();
        if (!raw) {
          if (!viewer.available()) {
            ctx.ui.notify("The mini.pick file finder requires Pi to run inside Herdr", "warning");
            return;
          }
          await ensureViewerPlugins(pi);
          await viewer.open(root, undefined, target);
          return;
        }
        const location = await resolveLocation(root, parseLocation(raw));
        if (viewer.available()) {
          await ensureViewerPlugins(pi);
          await viewer.open(root, location, target);
        } else {
          await showOverlay(ctx, location);
        }
      } catch (error) {
        ctx.ui.notify(`File viewer: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
