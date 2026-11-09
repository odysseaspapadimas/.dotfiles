import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { NEXT_STEPS_GUIDANCE, SETTINGS_TYPE, stateFromBranch, visibleReply, type NextStepsState } from "./core.ts";

const WIDGET = "next-steps";
const PICK_EVENT = "next-steps:pick";

export default function nextSteps(pi: ExtensionAPI) {
  let state: NextStepsState = { enabled: true, steps: [] };
  let context: ExtensionContext | undefined;
  let revision = 0;
  let picking = false;
  let unsubscribe: (() => void) | undefined;

  pi.registerMarkdownTransformer((markdown, options) => options.messageType === "assistant"
    ? visibleReply(markdown, options.isStreaming) : markdown);

  const ready = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI && ctx.isIdle() && !ctx.hasPendingMessages();

  function draw(ctx: ExtensionContext, show = true): void {
    if (ctx.mode !== "tui") return;
    if (!show || !state.enabled || !state.steps.length || !ready(ctx)) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const steps = [...state.steps];
    const widgetRevision = revision;
    ctx.ui.setWidget(WIDGET, () => ({
      render(width) {
        const theme = ctx.ui.theme;
        return [
          theme.fg("dim", "Next steps · Ctrl+X p · /next-steps"),
          ...steps.map((step, index) => theme.fg("accent", `${index + 1}. `) + theme.fg("muted", step)),
        ].map((line) => truncateToWidth(line, Math.max(0, width), ""));
      },
      handleMouse(event) {
        const index = event.y - 1;
        if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl ||
          index < 0 || index >= steps.length || widgetRevision !== revision) return;
        void pick(ctx, false, index).catch((error) => notifyError(ctx, error));
        return { handled: true };
      },
      invalidate() {},
    }));
  }

  function sync(ctx: ExtensionContext, show = true): void {
    if (ctx.mode !== "tui") return;
    state = stateFromBranch(ctx.sessionManager.getBranch());
    revision++;
    draw(ctx, show);
  }

  function notifyError(ctx: ExtensionContext, error: unknown): void {
    if (context) ctx.ui.notify(`Next steps: ${String(error)}`, "error");
  }

  async function pick(ctx: ExtensionContext, send = false, index?: number): Promise<void> {
    if (picking) return;
    if (!ready(ctx)) {
      if (ctx.hasUI) ctx.ui.notify("Wait for Pi to finish before choosing a next step", "info");
      return;
    }
    sync(ctx);
    if (!state.enabled || !state.steps.length) {
      ctx.ui.notify(state.enabled ? "No suggestions on the latest reply" : "Next steps are off; use /next-steps on", "info");
      return;
    }
    const snapshot = { revision, sourceId: state.sourceId, steps: [...state.steps] };
    const valid = () => {
      if (!context || snapshot.revision !== revision || !ready(ctx)) return false;
      const current = stateFromBranch(ctx.sessionManager.getBranch());
      return current.enabled && current.sourceId === snapshot.sourceId &&
        snapshot.steps.every((step, at) => current.steps[at] === step);
    };
    picking = true;
    try {
      const step = index === undefined
        ? await ctx.ui.select(send ? "Send a next step now" : "Choose a next step to edit", snapshot.steps)
        : snapshot.steps[index];
      if (!step || !snapshot.steps.includes(step)) return;
      if (!valid()) {
        if (context) ctx.ui.notify("The conversation changed; choose a next step again", "info");
        return;
      }
      if (send) {
        // Explicit opt-in only. Never submit the editor, expand commands, or queue behind other work.
        pi.sendUserMessage(step, { expandPromptTemplates: false });
        revision++;
        draw(ctx, false);
        return;
      }
      const draft = ctx.ui.getEditorText();
      if (draft.length > 0) {
        const action = await ctx.ui.select("Keep your draft and append this next step?", ["Append to draft", "Cancel"]);
        if (action !== "Append to draft") return;
      }
      if (!valid() || ctx.ui.getEditorText() !== draft) {
        if (context) ctx.ui.notify("The conversation or draft changed; nothing was inserted", "info");
        return;
      }
      ctx.ui.setEditorText(draft ? `${draft}\n\n${step}` : step);
    } finally {
      picking = false;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    sync(ctx);
    unsubscribe?.();
    // The Ctrl+X prefix emits this directly so it never submits/restores an editor draft.
    unsubscribe = pi.events.on(PICK_EVENT, () => {
      const current = context;
      if (current) void pick(current).catch((error) => notifyError(current, error));
    });
  });
  pi.on("session_tree", (_event, ctx) => sync(ctx));
  pi.on("session_compact", (_event, ctx) => sync(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    revision++;
    draw(ctx, false);
    if (ctx.mode === "tui" && state.enabled && event.messageType === "user") {
      // Participate in Pi's structured prompt composition; do not replace the system prompt.
      event.systemPromptOptions.sections.next_steps = NEXT_STEPS_GUIDANCE;
    } else {
      delete event.systemPromptOptions.sections.next_steps;
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    revision++;
    draw(ctx, false);
  });
  pi.on("agent_settled", (event, ctx) => sync(ctx, !event.aborted));
  pi.on("session_shutdown", (_event, ctx) => {
    revision++;
    context = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
  });

  pi.registerCommand("next-steps", {
    description: "Pick a suggested follow-up; /next-steps [1-3|send [1-3]|on|off|status]",
    getArgumentCompletions(prefix) {
      return ["on", "off", "status", "send", ...state.steps.map((_step, index) => String(index + 1))]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Next steps require Pi's interactive terminal UI", "info");
        return;
      }
      const value = args.trim();
      if (value === "on" || value === "off") {
        pi.appendEntry(SETTINGS_TYPE, { enabled: value === "on" });
        sync(ctx);
        ctx.ui.notify(`Next steps ${value} for this session`, "info");
      } else if (value === "status") {
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the active chat model";
        ctx.ui.notify(`Next steps ${state.enabled ? "on" : "off"} · ${model} · same response, no extra model call`, "info");
      } else if (/^(?:send(?: [1-3])?|[1-3])?$/.test(value)) {
        const number = /[1-3]$/.exec(value)?.[0];
        await pick(ctx, value.startsWith("send"), number ? Number(number) - 1 : undefined);
      } else {
        ctx.ui.notify("Usage: /next-steps [1-3|send [1-3]|on|off|status]", "info");
      }
    },
  });
}
