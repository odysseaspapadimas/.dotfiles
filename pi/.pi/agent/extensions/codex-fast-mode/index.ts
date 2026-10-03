import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const STATE_ENTRY_TYPE = "codex-fast-mode-state-v1";
const CODEX_ORIGINATOR = "codex_cli_rs";
const WEBSOCKET_PATCH_KEY = Symbol.for("codex-fast-mode.websocket-patch");
type WebSocketPatchState = { enabled: boolean; installed: boolean };

function installWebSocketOriginatorPatch(): WebSocketPatchState {
	const globals = globalThis as typeof globalThis & { [WEBSOCKET_PATCH_KEY]?: WebSocketPatchState };
	const state = globals[WEBSOCKET_PATCH_KEY] ??= { enabled: false, installed: false };
	if (state.installed || typeof globalThis.WebSocket !== "function") return state;

	const NativeWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = new Proxy(NativeWebSocket, {
		construct(target, args, newTarget) {
			const [url, options, ...rest] = args;
			const endpoint = new URL(String(url));
			if (state.enabled && endpoint.hostname === "chatgpt.com" && endpoint.pathname.startsWith("/backend-api/codex/") &&
				options && typeof options === "object" && !Array.isArray(options)) {
				const candidate = options as { headers?: HeadersInit };
				const headers = new Headers(candidate.headers);
				headers.set("originator", CODEX_ORIGINATOR);
				args = [url, { ...options, headers }, ...rest];
			}
			return Reflect.construct(target, args, newTarget);
		},
	}) as typeof WebSocket;
	state.installed = true;
	return state;
}

// Built-in footer sorts extension statuses by key. The zz- prefix keeps this last.
const STATUS_KEY = "zz-codex-fast-mode";

export const FAST_MODE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
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

export default function codexFastMode(pi: ExtensionAPI) {
	let enabled = false;
	const websocketPatch = installWebSocketOriginatorPatch();

	const updateStatus = (ctx: Pick<ExtensionContext, "model" | "ui">) => {
		websocketPatch.enabled = enabled && supportsFastMode(ctx.model);
		const text = enabled && supportsFastMode(ctx.model)
			? ctx.ui.theme.fg("accent", "fast")
			: undefined;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	// Leave Pi's native provider, auth, thinking mapping, and stream hooks intact.
	// Only change the wire payload instead of rebuilding SimpleStreamOptions.
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx.model) || !event.payload ||
			typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});

	const restoreState = (ctx: ExtensionContext) => {
		enabled = restoreFastMode(ctx.sessionManager.getBranch());
		websocketPatch.enabled = enabled;
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		websocketPatch.enabled = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast Mode: /fast [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return options.length > 0 ? options : null;
		},
		handler: async (args, ctx) => {
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
			websocketPatch.enabled = enabled;
			pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(`Codex Fast Mode ${enabled ? "enabled" : "disabled"}.`, enabled ? "warning" : "info");
		},
	});
}
