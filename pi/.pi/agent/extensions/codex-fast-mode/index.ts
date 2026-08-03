import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OpenAICodexResponsesOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const STATE_ENTRY_TYPE = "codex-fast-mode-state-v1";
// Built-in footer sorts extension statuses by key. The zz- prefix keeps this last.
const STATUS_KEY = "zz-codex-fast-mode";

export const FAST_MODE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export type FastModeModel = Pick<Model<any>, "provider" | "api" | "id">;

export function supportsFastMode(model: FastModeModel | undefined): boolean {
	return model?.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		FAST_MODE_MODEL_IDS.has(model.id);
}

export function restoreFastMode(entries: readonly unknown[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			customType?: unknown;
			data?: { enabled?: unknown };
		};
		if (
			candidate.type === "custom" &&
			candidate.customType === STATE_ENTRY_TYPE &&
			typeof candidate.data?.enabled === "boolean"
		) enabled = candidate.data.enabled;
	}
	return enabled;
}

function nativeFastOptions(
	model: Model<"openai-codex-responses">,
	options: SimpleStreamOptions | undefined,
): OpenAICodexResponsesOptions {
	const clamped = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : undefined),
		signal: options?.signal,
		apiKey: options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		headers: options?.headers,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		reasoningEffort: clamped === "off" ? undefined : clamped,
		serviceTier: "priority",
	};
}

export default function codexFastMode(pi: ExtensionAPI) {
	let enabled = false;

	const updateStatus = (ctx: Pick<ExtensionContext, "model" | "ui">) => {
		const text = enabled && supportsFastMode(ctx.model)
			? ctx.ui.theme.fg("accent", "fast")
			: undefined;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: (
			model: Model<"openai-codex-responses">,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			if (!enabled || !supportsFastMode(model)) {
				return streamSimpleOpenAICodexResponses(model, context, options);
			}
			return streamOpenAICodexResponses(model, context, nativeFastOptions(model, options));
		},
	});

	const restoreState = (ctx: ExtensionContext) => {
		enabled = restoreFastMode(ctx.sessionManager.getBranch());
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast Mode: /fast [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return options.length > 0 ? options : null;
		},
		handler: (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				const applicability = supportsFastMode(ctx.model) ? "supported model" : "unsupported model";
				ctx.ui.notify(`Codex Fast Mode is ${enabled ? "on" : "off"} (${applicability}).`, "info");
				return;
			}
			if (action !== "" && action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}

			enabled = action === "on" || (action === "" && !enabled);
			pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(`Codex Fast Mode ${enabled ? "enabled" : "disabled"}.`, enabled ? "warning" : "info");
		},
	});
}
