import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResponseSummary {
	model: string;
	durationMs: number;
	toolCount: number;
	toolTimeMs: number;
	failureCount: number;
}

interface ActiveRun extends Omit<ResponseSummary, "durationMs"> {
	startedAt: number;
	pending: Map<string, number>;
}

/** End-of-run stats only: no commands, argument previews, or persisted history. */
export default function responseTime(pi: ExtensionAPI) {
	let active: ActiveRun | undefined;

	const beginRun = (ctx: ExtensionContext, now = Date.now()): ActiveRun => {
		active = {
			model: ctx.model?.id ?? ctx.model?.name ?? "unknown",
			startedAt: now,
			toolCount: 0,
			toolTimeMs: 0,
			failureCount: 0,
			pending: new Map(),
		};
		return active;
	};

	const reset = () => { active = undefined; };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);

	pi.on("agent_start", (_event, ctx) => { beginRun(ctx); });

	pi.on("tool_execution_start", (event, ctx) => {
		const now = Date.now();
		const run = active ?? beginRun(ctx, now);
		run.toolCount++;
		run.pending.set(event.toolCallId, now);
	});

	pi.on("tool_execution_end", (event) => {
		if (!active) return;
		const startedAt = active.pending.get(event.toolCallId);
		if (startedAt === undefined) return;
		active.pending.delete(event.toolCallId);
		active.toolTimeMs += Math.max(0, Date.now() - startedAt);
		if (event.isError) active.failureCount++;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!active) return;
		const now = Date.now();
		// An aborted run may not emit an end event for every started tool.
		for (const startedAt of active.pending.values()) {
			active.toolTimeMs += Math.max(0, now - startedAt);
			active.failureCount++;
		}
		const summary: ResponseSummary = {
			model: active.model,
			durationMs: Math.max(0, now - active.startedAt),
			toolCount: active.toolCount,
			toolTimeMs: active.toolTimeMs,
			failureCount: active.failureCount,
		};
		active = undefined;
		if (ctx.hasUI) ctx.ui.notify(formatSummary(summary), summary.failureCount > 0 ? "warning" : "info");
	});
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatSummary(summary: ResponseSummary): string {
	return `${summary.model} • ${formatDuration(summary.durationMs)} • ${summary.toolCount} tools • ${formatDuration(summary.toolTimeMs)} tool time • ${summary.failureCount} failed`;
}
