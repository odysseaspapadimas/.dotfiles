import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionBackend } from "./pi-sessions/core.ts";

/** One Pi setup; choose only the terminal-manager adapter, never a desktop profile. */
export default function herdrApp(pi: ExtensionAPI) {
  if (sessionBackend(process.env) !== "core") return;
  const ui = join(homedir(), ".local/bin/herdr-ui");
  pi.on("before_agent_start", (event) => {
    // These instructions describe old Herdr-only APIs; neutral skills stay shared.
    event.systemPromptOptions.skills = event.systemPromptOptions.skills?.filter(
      skill => !["herdr", "project-worktree"].includes(skill.name));
    event.systemPromptOptions.sections.herdr_app = [
      "# Herdr App / Debina",
      `This Pi runs in Debina core terminal ${process.env.HC_TERMINAL_ID}.`,
      "Windows and Omarchy are screens onto this same process. Use the ordinary shared Pi config, login, history and pi_sessions.",
      "Use herdr_app for visible spaces/tabs/splits/focus/layouts. No profile or desktop selection is required.",
      "current locates this terminal's space/tab/pane; ls returns Debina's shared spaces. Inspect and use returned IDs.",
      "Shared structure is mutated ONCE; requested focus/layout changes are mirrored to connected desktops automatically.",
      "Use hc or pi_sessions for background workers, launch children with ordinary pi. Do not call the old herdr CLI from this core session.",
      "Do not kill or restart app/core/old Herdr or duplicate a session already running. An offline screen reconnects to the same running terminals.",
    ].join("\n");
  });
  pi.registerTool({
    name: "herdr_app",
    label: "Herdr App",
    description: "Manage the shared Debina workspace from any Herdr App screen. No client/profile selection. current locates the calling terminal, ls/status/commands inspect, do runs native tab/split/focus/layout commands, shot retrieves a screenshot. Shared mutations run once; navigation/layout changes mirror to reachable screens. Offline screens are reported, never auto-launched. Use hc/pi_sessions for programs and background agents.",
    promptGuidelines: [
      "Use herdr_app current or ls before visible topology changes. Use explicit IDs returned by inspection.",
      "Do not ask the user to select a profile or desktop. Automatic routing is the default; client is only an explicit user-requested override.",
      "Launch Pi with ordinary pi, not a separate profile. Never restart or close existing sessions as a migration step.",
    ],
    parameters: Type.Object({
      action: Type.Union(["clients", "current", "ls", "status", "commands", "do", "shot"].map(v => Type.Literal(v))),
      client: Type.Optional(Type.Union(["omarchy", "windows", "debina"].map(v => Type.Literal(v)))),
      command: Type.Optional(Type.String({ description: "For do: native command such as tab.new, pane.split, pane.focus, layout.switch" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      allow_destructive: Type.Optional(Type.Boolean({ description: "Only for user-authorized close/kill or cleanup of this agent's own tests" })),
    }),
    async execute(_id, params, signal) {
      const argv = [...(params.client ? ["--client", params.client] : []),
        ...(params.allow_destructive ? ["--allow-destructive"] : []), params.action];
      if (params.action === "do") {
        if (!params.command) throw new Error("do requires command");
        argv.push(params.command, JSON.stringify(params.args ?? {}));
      }
      const result = await pi.exec(ui, argv, { timeout: 90_000, signal });
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "App command failed; inspect before retrying.");
      const value = JSON.parse(result.stdout);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });
}
