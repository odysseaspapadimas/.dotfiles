import {
  CustomEditor,
  type AppKeybinding,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

const LEADER_KEY = "ctrl+x";
const CHORD_TIMEOUT_MS = 2_000;

type LeaderCommand =
  | { label: string; action: AppKeybinding }
  | { label: string; command: string; preserveDraft?: boolean };

const LEADER_COMMANDS: Record<string, LeaderCommand> = {
  c: { label: "copy", action: "app.message.copy" },
  m: { label: "model", action: "app.model.select" },
  s: { label: "settings", command: "/settings", preserveDraft: true },
  r: { label: "reload", command: "/reload" },
  l: { label: "sessions", action: "app.session.resume" },
  u: { label: "resume", action: "app.session.resume" },
  t: { label: "tree", action: "app.session.tree" },
  n: { label: "new", action: "app.session.new" },
  h: { label: "share", command: "/share", preserveDraft: true },
  o: { label: "quota", command: "/codex-quota", preserveDraft: true },
  i: { label: "login", command: "/login", preserveDraft: true },
  b: { label: "side chat", command: "/side", preserveDraft: true },
  d: { label: "diff", command: "/diff", preserveDraft: true },
  p: { label: "scratch", command: "/scratch", preserveDraft: true },
  z: { label: "restore files", command: "/restore", preserveDraft: true },
  j: { label: "side summary", command: "/side:inject summary", preserveDraft: true },
  "shift+j": { label: "side full handoff", command: "/side:inject raw", preserveDraft: true },
};

function getChord(data: string): LeaderCommand | undefined {
  for (const [key, command] of Object.entries(LEADER_COMMANDS)) {
    if (matchesKey(data, key as Parameters<typeof matchesKey>[1])) return command;
  }
  return undefined;
}

function buildHelpLines(theme: Theme, width: number): string[] {
  if (width < 20) {
    return [truncateToWidth(theme.fg("accent", "Ctrl+X shortcuts"), width, "")];
  }

  const border = (text: string) => theme.fg("border", text);
  const key = (text: string) => theme.fg("accent", theme.bold(text));
  const label = (text: string) => theme.fg("dim", text);
  const item = (shortcut: string, name: string) => `${key(shortcut)} ${label(name)}`;
  const rows = [
    `${theme.fg("muted", "Session ")} ${item("n", "new")}  ${item("l/u", "resume")}  ${item("t", "tree")}`,
    `${theme.fg("muted", "Pi      ")} ${item("m", "model")}  ${item("s", "settings")}  ${item("r", "reload")}`,
    `${theme.fg("muted", "Other   ")} ${item("b", "side")}  ${item("d", "diff")}  ${item("p", "scratch")}  ${item("z", "restore")}  ${item("c", "copy")}  ${item("h", "share")}  ${item("o", "quota")}  ${item("i", "login")}`,
    `${theme.fg("muted", "Side    ")} ${item("j", "summary handoff")}  ${item("J", "full handoff")}`,
    `${theme.fg("muted", "Help    ")} ${item("?", "show this window")}  ${label("Esc/Enter closes")}`,
  ];

  const innerWidth = width - 2;
  const title = theme.fg("accent", theme.bold(" Ctrl+X shortcuts "));
  const titleWidth = visibleWidth(title);
  const top = border("╭─") + title + border("─".repeat(Math.max(0, width - titleWidth - 3)) + "╮");
  const bottom = border("╰" + "─".repeat(innerWidth) + "╯");
  const body = rows.map((row) => {
    const content = truncateToWidth(row, innerWidth - 2, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content) - 1));
    return border("│") + " " + content + padding + border("│");
  });

  return [top, ...body, bottom];
}

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32 && data !== "\x7f";
}

export default function ctrlXPrefix(pi: ExtensionAPI) {
  let activeEditor: { dispose(): void } | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const previousEditor = ctx.ui.getEditorComponent();
    if (previousEditor) {
      ctx.ui.notify(
        "Ctrl+X prefix is replacing another custom editor",
        "warning",
      );
    }

    const showShortcutHelp = async (): Promise<void> => {
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => ({
          render: (width) => buildHelpLines(theme, width),
          invalidate: () => {},
          handleInput: (data) => {
            if (
              matchesKey(data, "escape") ||
              matchesKey(data, "enter") ||
              matchesKey(data, "q") ||
              matchesKey(data, "?")
            ) {
              done(undefined);
            }
          },
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 64,
            margin: 2,
          },
        },
      );
    };

    class CtrlXEditor extends CustomEditor {
      private waitingForChord = false;
      private chordTimer: ReturnType<typeof setTimeout> | undefined;
      private normalBorderColor: ((text: string) => string) | undefined;

      constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
      ) {
        super(tui, theme, keybindings);
      }

      dispose(): void {
        this.clearChordTimer();
        this.restoreBorderColor();
      }

      private clearChordTimer(): void {
        if (this.chordTimer) clearTimeout(this.chordTimer);
        this.chordTimer = undefined;
      }

      private restoreBorderColor(): void {
        if (this.normalBorderColor) {
          this.borderColor = this.normalBorderColor;
          this.normalBorderColor = undefined;
        }
      }

      private setChordWaiting(waiting: boolean): void {
        this.clearChordTimer();
        this.waitingForChord = waiting;

        if (waiting) {
          this.normalBorderColor = this.borderColor;
          this.borderColor = (text) => ctx.ui.theme.fg("dim", text);
          this.chordTimer = setTimeout(() => {
            this.waitingForChord = false;
            this.chordTimer = undefined;
            this.restoreBorderColor();
            this.tui.requestRender();
          }, CHORD_TIMEOUT_MS);
        } else {
          this.restoreBorderColor();
        }

        this.tui.requestRender();
      }

      private runLeaderCommand(command: LeaderCommand): void {
        this.setChordWaiting(false);

        if ("action" in command) {
          const handler = this.actionHandlers.get(command.action);
          if (handler) {
            handler();
          } else {
            ctx.ui.notify(`${command.label} is not available`, "warning");
          }
          return;
        }

        const draft = this.getText();
        if (draft.length > 0 && !command.preserveDraft) {
          ctx.ui.notify(
            `Clear or submit the current draft before ${command.label}`,
            "warning",
          );
          return;
        }

        if (draft.length > 0) {
          const submitted = this.onSubmit?.(command.command) as unknown;
          void Promise.resolve(submitted).finally(() => {
            this.setText(draft);
            this.tui.requestRender();
          });
          return;
        }

        this.onSubmit?.(command.command);
      }

      handleInput(data: string): void {
        if (this.waitingForChord) {
          if (
            matchesKey(data, LEADER_KEY) ||
            matchesKey(data, "escape") ||
            matchesKey(data, "ctrl+g")
          ) {
            this.setChordWaiting(false);
            return;
          }

          if (matchesKey(data, "?")) {
            this.setChordWaiting(false);
            void showShortcutHelp();
            return;
          }

          const command = getChord(data);
          if (command) {
            this.runLeaderCommand(command);
            return;
          }

          this.setChordWaiting(false);
          if (isPrintableInput(data)) {
            super.handleInput(data);
          } else {
            ctx.ui.notify("Ctrl+X key is not mapped", "info");
          }
          return;
        }

        if (matchesKey(data, LEADER_KEY)) {
          this.setChordWaiting(true);
          return;
        }

        super.handleInput(data);
      }

    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CtrlXEditor(tui, theme, keybindings);
      activeEditor = editor;
      return editor;
    });
  });

  pi.on("session_shutdown", () => {
    activeEditor?.dispose();
    activeEditor = undefined;
  });
}
