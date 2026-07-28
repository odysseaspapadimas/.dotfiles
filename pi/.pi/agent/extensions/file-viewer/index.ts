import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const MAX_OVERLAY_BYTES = 2 * 1024 * 1024;
const WORKSPACE_EDITOR = process.env.PI_WORKSPACE_EDITOR_BIN ?? join(homedir(), ".local", "bin", "workspace-editor");

interface Location { path: string; line?: number }

export function parseLocation(input: string): Location {
  const trimmed = input.trim();
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (!match || !match[1]) return { path: trimmed };
  return { path: match[1], line: Math.max(1, Number(match[2])) };
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
  return result.code === 0 ? realpath(result.stdout.trim()) : realpath(cwd);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
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
  pi.registerCommand("view", {
    description: "Open the standalone workspace editor: /view [--split] [path[:line]]",
    handler: async (args, ctx) => {
      try {
        const root = await gitRoot(pi, ctx.cwd);
        const split = /^\s*--split(?:\s|$)/.test(args);
        const raw = args.replace(/^\s*--(?:split|tab)(?:\s+|$)/, "").trim();
        const location = raw ? await resolveLocation(root, parseLocation(raw)) : undefined;

        if (process.env.HERDR_ENV === "1") {
          await access(WORKSPACE_EDITOR);
          const editorArgs = [split ? "--split" : "--tab"];
          if (location) editorArgs.push(`${location.path}${location.line ? `:${location.line}` : ""}`);
          const result = await pi.exec(WORKSPACE_EDITOR, editorArgs, { cwd: root, timeout: 15_000 });
          if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not open workspace editor");
          return;
        }

        if (!location) {
          ctx.ui.notify("The project file picker requires Pi to run inside Herdr", "warning");
          return;
        }
        await showOverlay(ctx, location);
      } catch (error) {
        ctx.ui.notify(`File viewer: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
