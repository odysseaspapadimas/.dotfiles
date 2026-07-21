import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { appendJournalAtomically, atomicPrivateWrite, prepareProjectScratch, promotionAppend, readScratch, resolveProjectScratch, type ProjectScratchPaths } from "./src/storage.js";

const AUTOSAVE_MS = 750;

type SaveState = "saved" | "modified" | "saving" | "error";

function framed(theme: Theme, title: string, body: string[], footer: string, width: number): string[] {
  const boxWidth = Math.max(24, width);
  const innerWidth = boxWidth - 2;
  const border = (text: string) => theme.fg("border", text);
  const backgroundTemplate = theme.bg("customMessageBg", "\u0000");
  const [backgroundStart = "", backgroundEnd = ""] = backgroundTemplate.split("\u0000");
  const paintBackground = (text: string) => {
    // Editor-rendered content may carry background resets or inherited fills.
    // Remove those first so every interior cell—including padding—uses exactly
    // one modal background. Foreground/Markdown styling remains intact.
    const withoutBackground = text.replace(/\x1b\[(?:4\d|10[0-7]|48;[\d;]+|49)m/gu, "");
    return backgroundStart + withoutBackground.replaceAll("\x1b[0m", `\x1b[0m${backgroundStart}`) + backgroundEnd;
  };
  const heading = theme.fg("accent", theme.bold(` ${title} `));
  const topFill = Math.max(0, innerWidth - visibleWidth(heading) - 1);
  const top = border("╭─") + heading + border(`${"─".repeat(topFill)}╮`);
  const rule = border("├") + paintBackground(border("─".repeat(innerWidth))) + border("┤");
  const bottom = border(`╰${"─".repeat(innerWidth)}╯`);
  const row = (content: string) => {
    const clipped = truncateToWidth(content, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return border("│") + paintBackground(clipped + padding) + border("│");
  };
  // Only the modal interior is opaque: borders retain the terminal background.
  // Reapply the fill after ANSI resets emitted by the editor's inverse cursor.
  return [top, ...body.map(row), rule, row(footer), bottom];
}

function editorTheme(theme: Theme): EditorTheme {
  return { borderColor: (s) => theme.fg("border", s), selectList: { selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s), description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => theme.fg("warning", s) } };
}

class ScratchEditor implements Focusable {
  focused = false;
  private readonly editor: Editor;
  private state: SaveState = "saved";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private tui: TUI, private theme: Theme, private paths: ProjectScratchPaths, initial: string, private done: (text: string) => void, private persist = true) {
    this.editor = new Editor(tui, editorTheme(theme), { paddingX: 1 });
    this.editor.setText(initial);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => { this.state = "modified"; if (this.persist) this.schedule(); this.tui.requestRender(); };
  }
  private schedule(): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.save(), AUTOSAVE_MS); }
  private save(): Promise<void> {
    if (!this.persist) { this.state = "saved"; return Promise.resolve(); }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.editor.getExpandedText();
    this.state = "saving";
    this.tui.requestRender();
    this.saveChain = this.saveChain.then(() => atomicPrivateWrite(this.paths.scratchPath, text)).then(() => { this.state = "saved"; }, () => { this.state = "error"; }).finally(() => this.tui.requestRender());
    return this.saveChain;
  }
  private async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.save(); this.done(this.editor.getExpandedText()); }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { void this.close(); return; }
    if (matchesKey(data, "ctrl+s")) { void this.save(); return; }
    if (matchesKey(data, "enter")) { this.editor.insertTextAtCursor("\n"); return; }
    this.editor.handleInput(data);
  }
  render(width: number): string[] {
    this.editor.focused = this.focused;
    const footerTone = this.state === "error" ? "error" : this.state === "saved" ? "success" : "warning";
    const footer = this.theme.fg(footerTone, this.state) + this.theme.fg("dim", " · private · Ctrl+S save · Esc save & close");
    const available = Math.max(3, Math.floor(this.tui.terminal.rows * 0.8) - 4);
    const rendered = this.editor.render(Math.max(20, width - 2));
    // The modal already supplies its own frame. Drop Editor's nested horizontal
    // rules and its inverse-video fake cursor; the hardware cursor marker remains.
    const body = rendered
      .slice(1, Math.max(1, rendered.length - 1))
      .slice(-available)
      .map((line) => line.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/gu, (_match, character: string) =>
        this.theme.fg("accent", this.theme.bold(character === " " ? "▌" : character)),
      ));
    const title = `Private scratch · ${this.paths.git ? "Git" : "cwd"}: ${this.paths.canonicalRoot}`;
    return framed(this.theme, title, body, footer, width);
  }
  invalidate(): void { this.editor.invalidate(); }
  dispose(): void { if (this.timer) clearTimeout(this.timer); if (!this.closed) void this.save(); }
}

class ReadOnlyView {
  private offset = 0;
  constructor(private tui: TUI, private theme: Theme, private title: string, private content: string, private done: () => void, private markdown = true) {}
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.done();
    const page = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
    else if (matchesKey(data, "pageDown")) this.offset += page;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const contentWidth = Math.max(20, width - 2);
    const rendered = this.markdown ? new Markdown(this.content || "_(empty)_", 1, 0, getMarkdownTheme()).render(contentWidth) : this.content.split("\n").map((line) => ` ${line}`);
    const count = Math.max(1, Math.floor(this.tui.terminal.rows * 0.75) - 4);
    this.offset = Math.min(this.offset, Math.max(0, rendered.length - count));
    const footer = this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · Esc close · ${this.offset + 1}-${Math.min(rendered.length, this.offset + count)}/${rendered.length}`);
    return framed(this.theme, this.title, rendered.slice(this.offset, this.offset + count), footer, width);
  }
  invalidate(): void {}
}

async function openEditor(ctx: ExtensionCommandContext, paths: ProjectScratchPaths, initial?: string, persist = true): Promise<string | undefined> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/scratch editor requires Pi's interactive TUI", "warning"); return undefined; }
  const text = initial ?? await readScratch(paths.scratchPath);
  return ctx.ui.custom<string>((tui, theme, _kb, done) => new ScratchEditor(tui, theme, paths, text, done, persist), { overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 48, maxHeight: "85%", margin: 1 } });
}

async function showText(ctx: ExtensionCommandContext, title: string, text: string, markdown = true): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify(text || "(empty)", "info"); return; }
  await ctx.ui.custom<void>((tui, theme, _kb, done) => new ReadOnlyView(tui, theme, title, text, () => done(), markdown), { overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 48, maxHeight: "85%", margin: 1 } });
}

export default function projectScratch(pi: ExtensionAPI) {
  async function paths(ctx: ExtensionCommandContext): Promise<ProjectScratchPaths> { const value = await resolveProjectScratch(ctx.cwd); await prepareProjectScratch(value); return value; }
  pi.registerCommand("scratch", {
    description: "Private project scratchpad: /scratch [show|clear|path|promote]",
    handler: async (args, ctx) => {
      try {
        const project = await paths(ctx);
        const action = args.trim().toLowerCase();
        if (!action) { await openEditor(ctx, project); return; }
        if (action === "path") { ctx.ui.notify(project.scratchPath, "info"); return; }
        if (action === "show") { await showText(ctx, `Private scratch · ${project.canonicalRoot}`, await readScratch(project.scratchPath)); return; }
        if (action === "clear") {
          if (await ctx.ui.confirm("Clear private scratch?", `Erase ${project.scratchPath}?`)) { await atomicPrivateWrite(project.scratchPath, ""); ctx.ui.notify("Private scratch cleared", "info"); }
          return;
        }
        if (action === "promote") {
          const original = await readScratch(project.scratchPath);
          if (!original.trim()) { ctx.ui.notify("Private scratch is empty", "info"); return; }
          const selected = await openEditor(ctx, project, original, false);
          if (selected === undefined || !selected.trim()) return;
          const append = promotionAppend(selected);
          await showText(ctx, "Exact journal append preview", append, false);
          if (!await ctx.ui.confirm("Append to project journal?", `Append the exact preview to ${project.canonicalRoot}/.agents/project-journal.md?`)) return;
          const journal = await appendJournalAtomically(project.canonicalRoot, append);
          ctx.ui.notify(`Promoted scratch selection to ${journal}`, "info");
          if (await ctx.ui.confirm("Clear promoted scratch?", "Clear the private scratch now? Choose No (or Esc) to keep it.")) await atomicPrivateWrite(project.scratchPath, "");
          return;
        }
        ctx.ui.notify("Usage: /scratch [show|clear|path|promote]", "warning");
      } catch (error) { ctx.ui.notify(`Scratch error: ${String(error)}`, "error"); }
    },
  });
}
