import {
  SessionManager,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SIDE_MODE = process.env.PI_HERDR_SIDE === "1";
const SOURCE_SESSION = process.env.PI_HERDR_SIDE_SOURCE;
const SOURCE_LEAF = process.env.PI_HERDR_SIDE_SOURCE_LEAF;
const PARENT_PANE = process.env.PI_HERDR_SIDE_PARENT_PANE;
const WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const CURRENT_PANE = process.env.HERDR_PANE_ID;
const SHARED_AGENT_DIR = process.env.PI_HERDR_SIDE_SHARED_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SIDE_AGENT_DIR = join(SHARED_AGENT_DIR, "herdr-side-chat", "runtime");

interface HerdrPane {
  pane_id: string;
  label?: string;
  focused?: boolean;
}

interface SideHandoff {
  id: string;
  createdAt: number;
  sourcePane?: string;
  content: string;
}

interface PendingSummary {
  token: string;
  instructions?: string;
}

const SUMMARY_MARKER = "[herdr-side-chat:summary:";
const RAW_WARNING_TOKENS = 20_000;

interface HerdrResponse {
  result?: {
    pane?: HerdrPane;
    panes?: HerdrPane[];
    layout?: {
      area: { width: number; height: number };
      panes: Array<{
        pane_id: string;
        rect: { x: number; y: number; width: number; height: number };
      }>;
    };
  };
  error?: { message?: string };
}

function sideLabel(parentPane: string): string {
  return `side-chat ${parentPane}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function mailboxDirectory(parentPane: string): string {
  const safePane = parentPane.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SHARED_AGENT_DIR, "herdr-side-chat", "mailboxes", safePane);
}

async function prepareSideAgentDirectory(): Promise<void> {
  await mkdir(SIDE_AGENT_DIR, { recursive: true, mode: 0o700 });

  // Use the normal Pi resources and credentials, but keep a side-only settings
  // file so quiet startup does not alter the main Pi experience.
  const entries = await readdir(SHARED_AGENT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "settings.json" || entry.name === "sessions" || entry.name === "herdr-side-chat") continue;
    const source = join(SHARED_AGENT_DIR, entry.name);
    const target = join(SIDE_AGENT_DIR, entry.name);
    try {
      const existing = await lstat(target);
      if (!existing.isSymbolicLink() || (await readlink(target)) !== source) {
        throw new Error(`Unexpected side-chat runtime entry: ${target}`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      await symlink(source, target, entry.isDirectory() ? "dir" : "file");
    }
  }

  const settingsPath = join(SHARED_AGENT_DIR, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await writeFile(join(SIDE_AGENT_DIR, "settings.json"), `${JSON.stringify({ ...settings, quietStartup: true }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function containsSummaryMarker(content: unknown, token?: string): boolean {
  const text = messageText(content);
  return token ? text.includes(`${SUMMARY_MARKER}${token}]`) : text.includes(SUMMARY_MARKER);
}

function filterSummaryArtifacts<T extends { role: string; content?: unknown }>(messages: readonly T[], keepToken?: string): T[] {
  const filtered: T[] = [];
  let skippingResponse = false;

  for (const message of messages) {
    if (message.role === "user") {
      if (containsSummaryMarker(message.content)) {
        if (keepToken && containsSummaryMarker(message.content, keepToken)) {
          skippingResponse = false;
          filtered.push(message);
        } else {
          skippingResponse = true;
        }
        continue;
      }
      skippingResponse = false;
    }
    if (!skippingResponse) filtered.push(message);
  }
  return filtered;
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokenEstimate(tokens: number): string {
  return tokens >= 1_000 ? `~${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens` : `~${tokens} tokens`;
}

export default function herdrSideChat(pi: ExtensionAPI) {
  let inheritedMessages: ReturnType<typeof buildSessionContext>["messages"] = [];
  let sidePaneId: string | undefined;
  let mailboxWatcher: FSWatcher | undefined;
  let mailboxRetry: ReturnType<typeof setTimeout> | undefined;
  let drainingMailbox = false;
  let drainAgain = false;
  let pendingSummary: PendingSummary | undefined;

  function stopMailbox(): void {
    mailboxWatcher?.close();
    mailboxWatcher = undefined;
    if (mailboxRetry) clearTimeout(mailboxRetry);
    mailboxRetry = undefined;
  }

  async function deliverHandoff(ctx: ExtensionContext, handoff: SideHandoff): Promise<void> {
    if (ctx.isIdle()) {
      pi.sendUserMessage(handoff.content);
      return;
    }
    pi.sendUserMessage(handoff.content, { deliverAs: "followUp" });
  }

  async function drainMailbox(ctx: ExtensionContext): Promise<void> {
    if (!CURRENT_PANE || SIDE_MODE) return;
    if (drainingMailbox) {
      drainAgain = true;
      return;
    }

    drainingMailbox = true;
    const directory = mailboxDirectory(CURRENT_PANE);
    try {
      do {
        drainAgain = false;
        const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
        for (const name of names) {
          const path = join(directory, name);
          try {
            const handoff = JSON.parse(await readFile(path, "utf8")) as SideHandoff;
            if (!handoff.id || !handoff.content?.trim()) throw new Error("Invalid side-chat handoff payload");
            await deliverHandoff(ctx, handoff);
            await unlink(path);
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
            // Keep valid but temporarily undeliverable handoffs for retry. Move malformed
            // payloads aside so one bad file cannot block the mailbox forever.
            if (error instanceof SyntaxError || (error instanceof Error && error.message === "Invalid side-chat handoff payload")) {
              await rename(path, `${path}.invalid`).catch(() => {});
              ctx.ui.notify(`Invalid side-chat handoff: ${name}`, "error");
              continue;
            }
            throw error;
          }
        }
      } while (drainAgain);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      mailboxRetry = setTimeout(() => {
        mailboxRetry = undefined;
        void drainMailbox(ctx);
      }, 1_000);
    } finally {
      drainingMailbox = false;
    }
  }

  async function startMailbox(ctx: ExtensionContext): Promise<void> {
    if (!CURRENT_PANE || SIDE_MODE) return;
    stopMailbox();
    const directory = mailboxDirectory(CURRENT_PANE);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    mailboxWatcher = watch(directory, () => void drainMailbox(ctx));
    await drainMailbox(ctx);
  }

  async function writeHandoff(content: string): Promise<void> {
    if (!PARENT_PANE) throw new Error("Main pane ID is unavailable");
    const directory = mailboxDirectory(PARENT_PANE);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const finalPath = join(directory, `${Date.now()}-${id}.json`);
    const temporaryPath = `${finalPath}.tmp`;
    const handoff: SideHandoff = { id, createdAt: Date.now(), sourcePane: CURRENT_PANE, content };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(handoff)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  function localTurns(ctx: ExtensionContext): string[] {
    const turns: string[] = [];
    let skippingSummaryResponse = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const { message } = entry;
      if (message.role === "user") {
        if (containsSummaryMarker(message.content)) {
          skippingSummaryResponse = true;
          continue;
        }
        skippingSummaryResponse = false;
      }
      if (skippingSummaryResponse || (message.role !== "user" && message.role !== "assistant")) continue;
      const text = messageText(message.content);
      if (!text) continue;
      turns.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
    }
    return turns;
  }

  function buildRawHandoff(ctx: ExtensionContext): string | null {
    const turns = localTurns(ctx);
    if (turns.length === 0) return null;
    return `Here is the full transcript from an ephemeral side conversation:\n\n${turns.join("\n\n")}`;
  }

  function summaryResponse(ctx: ExtensionContext, token: string): string | null {
    let afterRequest = false;
    let response = "";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "user" && containsSummaryMarker(entry.message.content, token)) {
        afterRequest = true;
        response = "";
        continue;
      }
      if (!afterRequest || entry.message.role !== "assistant") continue;
      const text = messageText(entry.message.content);
      if (text) response = text;
    }
    return response || null;
  }

  function buildSummaryPrompt(token: string, instructions?: string): string {
    const guidance = instructions?.trim()
      ? `\nAdditional emphasis from the user:\n${instructions.trim()}\n`
      : "";
    return `${SUMMARY_MARKER}${token}]\nCreate a concise handoff summarizing only the side-local conversation before this request. Do not include inherited main-session context. Do not use tools. Preserve concrete decisions, progress, file paths, unresolved issues, and next steps. Use only sections that are relevant from: Goal, Decisions, Progress, Files, Open questions, Recommended next steps.${guidance}\nReply with the handoff only.`;
  }

  async function injectRaw(ctx: ExtensionCommandContext): Promise<void> {
    const content = buildRawHandoff(ctx);
    if (!content) {
      ctx.ui.notify("There is no side conversation to inject yet.", "warning");
      return;
    }

    const estimate = tokenEstimate(content);
    if (estimate >= RAW_WARNING_TOKENS) {
      const confirmed = await ctx.ui.confirm(
        "Large side-chat handoff",
        `Inject the full transcript (${formatTokenEstimate(estimate)}) into the main conversation?`,
      );
      if (!confirmed) return;
    }

    await writeHandoff(content);
    ctx.ui.notify(`Full side conversation handed off (${formatTokenEstimate(estimate)}).`, "info");
  }

  function beginSummary(ctx: ExtensionCommandContext, instructions?: string): void {
    if (pendingSummary) {
      ctx.ui.notify("A side-chat summary is already being generated.", "warning");
      return;
    }
    if (localTurns(ctx).length === 0) {
      ctx.ui.notify("There is no side conversation to summarize yet.", "warning");
      return;
    }

    const token = randomUUID();
    pendingSummary = { token, instructions: instructions?.trim() || undefined };
    pi.sendUserMessage(buildSummaryPrompt(token, pendingSummary.instructions));
    ctx.ui.notify("Generating a side-chat handoff summary…", "info");
  }

  async function herdr(args: string[]): Promise<HerdrResponse> {
    const result = await pi.exec("herdr", args, { timeout: 30_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `herdr ${args.join(" ")} failed`);
    }

    const output = result.stdout.trim();
    if (!output) return {};

    let parsed: HerdrResponse;
    try {
      parsed = JSON.parse(output) as HerdrResponse;
    } catch {
      throw new Error(`Invalid JSON from herdr ${args.slice(0, 2).join(" ")}: ${output}`);
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || "Herdr command failed");
    }
    return parsed;
  }

  async function paneExists(paneId: string): Promise<boolean> {
    try {
      await herdr(["pane", "get", paneId]);
      return true;
    } catch {
      return false;
    }
  }

  async function findSidePane(parentPane: string): Promise<string | undefined> {
    if (sidePaneId && (await paneExists(sidePaneId))) return sidePaneId;
    sidePaneId = undefined;
    if (!WORKSPACE_ID) return undefined;

    const response = await herdr(["pane", "list", "--workspace", WORKSPACE_ID]);
    const pane = response.result?.panes?.find((candidate) => candidate.label === sideLabel(parentPane));
    sidePaneId = pane?.pane_id;
    return sidePaneId;
  }

  async function focusPane(targetPane: string): Promise<void> {
    if (!CURRENT_PANE || targetPane === CURRENT_PANE) return;

    const response = await herdr(["pane", "layout", "--pane", CURRENT_PANE]);
    const panes = response.result?.layout?.panes ?? [];
    const current = panes.find((pane) => pane.pane_id === CURRENT_PANE);
    const target = panes.find((pane) => pane.pane_id === targetPane);
    if (!current || !target) throw new Error(`Pane ${targetPane} is not in the current tab`);

    const currentX = current.rect.x + current.rect.width / 2;
    const currentY = current.rect.y + current.rect.height / 2;
    const targetX = target.rect.x + target.rect.width / 2;
    const targetY = target.rect.y + target.rect.height / 2;
    const dx = targetX - currentX;
    const dy = targetY - currentY;
    const direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";

    await herdr(["pane", "focus", "--direction", direction, "--current"]);
  }

  async function closeSidePane(parentPane: string): Promise<boolean> {
    const paneId = await findSidePane(parentPane);
    if (!paneId) return false;
    await herdr(["pane", "close", paneId]);
    sidePaneId = undefined;
    return true;
  }

  async function createSidePane(ctx: ExtensionCommandContext): Promise<void> {
    if (process.env.HERDR_ENV !== "1" || !CURRENT_PANE) {
      ctx.ui.notify("Side chat requires Pi to run inside Herdr.", "error");
      return;
    }

    const source = ctx.sessionManager.getSessionFile();
    if (!source) {
      ctx.ui.notify("The main session is ephemeral, so there is no session context to inherit.", "error");
      return;
    }

    await prepareSideAgentDirectory();

    const layoutResponse = await herdr(["pane", "layout", "--pane", CURRENT_PANE]);
    const area = layoutResponse.result?.layout?.area;
    const direction = !area || area.width >= area.height * 1.4 ? "right" : "down";
    const sourceLeaf = ctx.sessionManager.getLeafId();
    const splitArgs = [
      "pane",
      "split",
      "--current",
      "--direction",
      direction,
      "--ratio",
      // Herdr's ratio applies to the existing (main) pane, leaving 35% for the new side pane.
      "0.65",
      "--cwd",
      ctx.cwd,
      "--env",
      "PI_HERDR_SIDE=1",
      "--env",
      `PI_CODING_AGENT_DIR=${SIDE_AGENT_DIR}`,
      "--env",
      `PI_HERDR_SIDE_SHARED_AGENT_DIR=${SHARED_AGENT_DIR}`,
      "--env",
      `PI_HERDR_SIDE_SOURCE=${source}`,
      ...(sourceLeaf ? ["--env", `PI_HERDR_SIDE_SOURCE_LEAF=${sourceLeaf}`] : []),
      "--env",
      `PI_HERDR_SIDE_PARENT_PANE=${CURRENT_PANE}`,
      "--focus",
    ];
    const splitResponse = await herdr(splitArgs);
    const paneId = splitResponse.result?.pane?.pane_id;
    if (!paneId) throw new Error("Herdr did not return a pane ID");

    sidePaneId = paneId;
    await herdr(["pane", "rename", paneId, sideLabel(CURRENT_PANE)]);

    const command = [
      "pi",
      "--no-session",
      ctx.model ? `--provider ${shellQuote(ctx.model.provider)}` : "",
      ctx.model ? `--model ${shellQuote(ctx.model.id)}` : "",
      `--thinking ${shellQuote(pi.getThinkingLevel())}`,
    ]
      .filter(Boolean)
      .join(" ");
    await herdr(["pane", "run", paneId, command]);
  }

  if (SIDE_MODE) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("herdr-side-chat", ctx.ui.theme.fg("accent", "side: ephemeral"));
      if (!SOURCE_SESSION) {
        ctx.ui.notify("PI_HERDR_SIDE_SOURCE is missing; this side chat has no inherited context.", "error");
        return;
      }

      try {
        const source = SessionManager.open(SOURCE_SESSION);
        inheritedMessages = buildSessionContext(source.getEntries(), SOURCE_LEAF ?? source.getLeafId()).messages;
      } catch (error) {
        inheritedMessages = [];
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    });

    pi.on("context", (event) => {
      if (pendingSummary) {
        // Summaries see only the side-local branch. Previous synthetic summary turns
        // are removed, while the current request remains visible to the model.
        return { messages: filterSummaryArtifacts(event.messages, pendingSummary.token) };
      }
      if (inheritedMessages.length === 0) return;
      return { messages: [...inheritedMessages, ...filterSummaryArtifacts(event.messages)] };
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!pendingSummary) return;
      const request = pendingSummary;
      pendingSummary = undefined;
      const summary = summaryResponse(ctx, request.token);
      if (!summary) {
        ctx.ui.notify("The side-chat summary did not produce a handoff.", "error");
        return;
      }

      try {
        await writeHandoff(`Here is a summarized handoff from an ephemeral side conversation:\n\n${summary}`);
        ctx.ui.notify(`Summarized side conversation handed off (${formatTokenEstimate(tokenEstimate(summary))}).`, "info");
      } catch (error) {
        ctx.ui.notify(`Summary generated, but handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });

    pi.registerCommand("side", {
      description: "Return focus to the main Herdr pane.",
      handler: async (_args, ctx) => {
        if (!PARENT_PANE) {
          ctx.ui.notify("Main pane ID is unavailable.", "error");
          return;
        }
        try {
          await focusPane(PARENT_PANE);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerCommand("side:inject", {
      description: "Inject the full side conversation, a summary, or a guided summary into the main Pi.",
      handler: async (args, ctx) => {
        try {
          const trimmed = args.trim();
          let mode = "";
          let instructions = "";

          if (trimmed) {
            const [first, ...rest] = trimmed.split(/\s+/);
            mode = first.toLowerCase();
            instructions = rest.join(" ");
          } else {
            const raw = buildRawHandoff(ctx);
            if (!raw) {
              ctx.ui.notify("There is no side conversation to inject yet.", "warning");
              return;
            }
            const estimate = formatTokenEstimate(tokenEstimate(raw));
            const choice = await ctx.ui.select("Inject side conversation", [
              `Summarize (${estimate} source) — recommended`,
              "Summarize with instructions…",
              `Full conversation (${estimate})`,
            ]);
            if (!choice) return;
            if (choice.startsWith("Full conversation")) mode = "raw";
            else if (choice.startsWith("Summarize with")) mode = "guided";
            else mode = "summary";
          }

          if (mode === "raw" || mode === "full" || mode === "no-summary") {
            await injectRaw(ctx);
            return;
          }

          if (mode === "guided" || mode === "custom") {
            if (!instructions) {
              const value = await ctx.ui.input("Focus the handoff summary on", "e.g. decisions, file paths, and unresolved risks");
              if (value === undefined) return;
              instructions = value.trim();
            }
            beginSummary(ctx, instructions || undefined);
            return;
          }

          if (mode === "summary") {
            beginSummary(ctx, instructions || undefined);
            return;
          }

          ctx.ui.notify("Usage: /side:inject [raw | summary [instructions] | guided]", "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerCommand("side:save", {
      description: "Persist this otherwise-ephemeral side conversation as a normal Pi session.",
      handler: async (_args, ctx) => {
        if (!SOURCE_SESSION) {
          ctx.ui.notify("Cannot save: source session is unavailable.", "error");
          return;
        }

        try {
          const saved = SessionManager.forkFrom(SOURCE_SESSION, ctx.cwd);
          if (SOURCE_LEAF && saved.getEntry(SOURCE_LEAF)) {
            saved.branch(SOURCE_LEAF);
          }
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message") {
              if (entry.message.role !== "branchSummary" && entry.message.role !== "compactionSummary") {
                saved.appendMessage(entry.message);
              }
            } else if (entry.type === "custom_message") {
              saved.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
            }
          }
          saved.appendSessionInfo("Saved side chat");
          ctx.ui.notify(`Saved side chat: ${saved.getSessionFile()}`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    return;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      await startMailbox(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });

  pi.on("session_shutdown", () => {
    stopMailbox();
  });

  pi.registerCommand("side", {
    description: "Create or focus an ephemeral Herdr side chat with this session's context.",
    handler: async (_args, ctx) => {
      if (process.env.HERDR_ENV !== "1" || !CURRENT_PANE) {
        ctx.ui.notify("Side chat requires Pi to run inside Herdr.", "error");
        return;
      }

      try {
        const existing = await findSidePane(CURRENT_PANE);
        if (existing) {
          await focusPane(existing);
        } else {
          await createSidePane(ctx);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("side:new", {
    description: "Discard the current side chat and create a fresh context snapshot.",
    handler: async (_args, ctx) => {
      if (!CURRENT_PANE) return;
      try {
        await closeSidePane(CURRENT_PANE);
        await createSidePane(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("side:close", {
    description: "Close and discard the ephemeral side chat.",
    handler: async (_args, ctx) => {
      if (!CURRENT_PANE) return;
      try {
        const closed = await closeSidePane(CURRENT_PANE);
        ctx.ui.notify(closed ? "Side chat discarded." : "No side chat is open.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
