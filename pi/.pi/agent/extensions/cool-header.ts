import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let currentModel = "no-model";
  let currentCwd = "";

  // Catppuccin mocha vertical gradient (top → bottom)
  const gradientColors = [
    "#cba6f7", // mauve
    "#e0a4e8", // mauve → pink
    "#f5c2e7", // pink
    "#b4befe", // lavender
    "#89b4fa", // blue
    "#74c7ec", // sapphire
  ];

  const artLines = [
    " ██████╗  ██╗",
    " ██╔══██╗ ██║",
    " ██████╔╝ ██║",
    " ██╔═══╝  ██║",
    " ██║      ██║",
    " ╚═╝      ╚═╝",
  ];

  function hexToRgb(hex: string) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }

  function lerpColor(hex1: string, hex2: string, t: number): string {
    const c1 = hexToRgb(hex1);
    const c2 = hexToRgb(hex2);
    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  function getGradientColor(lineIndex: number, totalLines: number): string {
    const t = lineIndex / Math.max(1, totalLines - 1);
    const scaledT = t * (gradientColors.length - 1);
    const idx = Math.floor(scaledT);
    const frac = scaledT - idx;
    if (idx >= gradientColors.length - 1) {
      const c = hexToRgb(gradientColors[gradientColors.length - 1]);
      return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
    }
    return lerpColor(gradientColors[idx], gradientColors[idx + 1], frac);
  }

  class CoolHeader {
    private theme: any;
    private ui: any;
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor(ui: any, theme: any) {
      this.ui = ui;
      this.theme = theme;
      // Re-render every minute so the clock updates
      this.interval = setInterval(() => {
        this.ui.requestRender();
      }, 60000);
    }

    dispose() {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
    }

    invalidate() {}

    render(width: number): string[] {
      const lines: string[] = [];

      // Gradient ASCII art — centered
      for (let i = 0; i < artLines.length; i++) {
        const line = artLines[i];
        const color = getGradientColor(i, artLines.length);
        const visWidth = visibleWidth(line);
        const pad = Math.max(0, Math.floor((width - visWidth) / 2));
        lines.push(" ".repeat(pad) + color + line + "\x1b[39m");
      }

      // Spacer
      lines.push("");

      // Info line: cwd · model · HH:MM — centered and muted
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const infoText = `${currentCwd} · ${currentModel} · ${timeStr}`;
      const infoVisWidth = visibleWidth(infoText);
      const infoPad = Math.max(0, Math.floor((width - infoVisWidth) / 2));
      lines.push(" ".repeat(infoPad) + this.theme.fg("muted", infoText));

      return lines;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const cwd = ctx.sessionManager.getCwd();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    currentCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

    const model = ctx.model;
    currentModel = model ? model.id : "no-model";

    ctx.ui.setHeader((ui, theme) => {
      return new CoolHeader(ui, theme);
    });
  });

  pi.on("model_select", async (event, _ctx) => {
    currentModel = event.model.id;
  });
}
