import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "turn-activity-v1";
const MAX_TURNS = 40;
const MAX_EVENTS_PER_TURN = 100;
const MAX_RECENT_EVENTS = 400;
const PREVIEW_LENGTH = 140;

export interface ActivityEvent {
	toolCallId: string;
	toolName: string;
	preview: string;
	startedAt: number;
	offsetMs: number;
	durationMs: number;
	failed: boolean;
}

export interface ActivityTurn {
	version: 1;
	id: string;
	model: string;
	startedAt: number;
	durationMs: number;
	toolCount: number;
	toolTimeMs: number;
	failureCount: number;
	droppedEvents: number;
	events: ActivityEvent[];
}

interface PendingTool {
	startedAt: number;
	event?: ActivityEvent;
}

interface ActiveTurn {
	id: string;
	model: string;
	startedAt: number;
	toolCount: number;
	toolTimeMs: number;
	failureCount: number;
	events: ActivityEvent[];
	pending: Map<string, PendingTool>;
}

type TimelineRow =
	| { kind: "turn"; turn: ActivityTurn; number: number }
	| { kind: "event"; event: ActivityEvent }
	| { kind: "note"; text: string };

export default function activityProfiler(pi: ExtensionAPI) {
	let active: ActiveTurn | null = null;
	let recentTurns: ActivityTurn[] = [];
	let sequence = 0;

	const reconstruct = (ctx: ExtensionContext) => {
		const restored: ActivityTurn[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const turn = parseActivityTurn(entry.data);
			if (turn) restored.push(turn);
		}
		recentTurns = boundTurns(restored);
		active = null;
	};

	const beginTurn = (ctx: ExtensionContext, now = Date.now()): ActiveTurn => {
		const turn: ActiveTurn = {
			id: `${now.toString(36)}-${(sequence++).toString(36)}`,
			model: ctx.model?.id ?? ctx.model?.name ?? "unknown",
			startedAt: now,
			toolCount: 0,
			toolTimeMs: 0,
			failureCount: 0,
			events: [],
			pending: new Map(),
		};
		active = turn;
		return turn;
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		active = beginTurn(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const now = Date.now();
		const turn = active ?? beginTurn(ctx, now);
		turn.toolCount++;

		let activityEvent: ActivityEvent | undefined;
		if (turn.events.length < MAX_EVENTS_PER_TURN) {
			activityEvent = {
				toolCallId: event.toolCallId,
				toolName: sanitizeLabel(event.toolName, 60),
				preview: sanitizeArgumentPreview(event.args),
				startedAt: now,
				offsetMs: Math.max(0, now - turn.startedAt),
				durationMs: 0,
				failed: false,
			};
			turn.events.push(activityEvent);
		}
		turn.pending.set(event.toolCallId, { startedAt: now, event: activityEvent });
	});

	pi.on("tool_execution_end", async (event) => {
		if (!active) return;
		const pending = active.pending.get(event.toolCallId);
		if (!pending) return;

		const durationMs = Math.max(0, Date.now() - pending.startedAt);
		active.pending.delete(event.toolCallId);
		active.toolTimeMs += durationMs;
		if (event.isError) active.failureCount++;
		if (pending.event) {
			pending.event.durationMs = durationMs;
			pending.event.failed = event.isError;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!active) return;
		const now = Date.now();

		// An aborted run may not emit an end event for every started tool.
		for (const pending of active.pending.values()) {
			const durationMs = Math.max(0, now - pending.startedAt);
			active.toolTimeMs += durationMs;
			active.failureCount++;
			if (pending.event) {
				pending.event.durationMs = durationMs;
				pending.event.failed = true;
			}
		}
		active.pending.clear();

		const completed: ActivityTurn = {
			version: 1,
			id: active.id,
			model: active.model,
			startedAt: active.startedAt,
			durationMs: Math.max(0, now - active.startedAt),
			toolCount: active.toolCount,
			toolTimeMs: active.toolTimeMs,
			failureCount: active.failureCount,
			droppedEvents: Math.max(0, active.toolCount - active.events.length),
			events: active.events.map((event) => ({ ...event })),
		};

		active = null;
		recentTurns = boundTurns([...recentTurns, completed]);
		pi.appendEntry<ActivityTurn>(ENTRY_TYPE, completed);

		if (ctx.hasUI) ctx.ui.notify(formatSummary(completed), completed.failureCount > 0 ? "warning" : "info");
	});

	pi.registerCommand("activity", {
		description: "Show recent turn and tool activity",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/activity requires interactive mode", "error");
				return;
			}

			const snapshot = recentTurns.map((turn) => ({
				...turn,
				events: turn.events.map((event) => ({ ...event })),
			}));
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ActivityView(snapshot, tui, theme, () => done()),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						minWidth: 48,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
		},
	});
}

export function sanitizeArgumentPreview(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const input = args as Record<string, unknown>;
	const candidates = ["command", "path", "pattern", "query"] as const;
	for (const key of candidates) {
		const value = input[key];
		if (typeof value !== "string" || value.length === 0) continue;
		const sanitized = redactSecrets(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
		return sanitizeLabel(`${key}=${sanitized}`, PREVIEW_LENGTH);
	}
	return "";
}

function redactSecrets(value: string): string {
	return value
		.replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, "[REDACTED KEY]")
		.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|token|secret|password|passwd|credential|cookie)\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s;&|]+)/gi, "$1[REDACTED]")
		.replace(/((?:--?|\/)(?:api[_-]?key|token|secret|password|passwd|credential|cookie)(?:=|\s+))('[^']*'|"[^"]*"|[^\s;&|]+)/gi, "$1[REDACTED]")
		.replace(/([?&](?:api[_-]?key|token|secret|password|passwd|credential|cookie)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function sanitizeLabel(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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

export function formatSummary(turn: ActivityTurn): string {
	return `${turn.model} • ${formatDuration(turn.durationMs)} • ${turn.toolCount} tools • ${formatDuration(turn.toolTimeMs)} tool time • ${turn.failureCount} failed`;
}

export function boundTurns(turns: ActivityTurn[]): ActivityTurn[] {
	const sorted = [...turns]
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(-MAX_TURNS);
	const kept: ActivityTurn[] = [];
	let eventCount = 0;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const turn = sorted[index];
		if (!turn) continue;
		if (kept.length > 0 && eventCount + turn.events.length > MAX_RECENT_EVENTS) break;
		kept.push(turn);
		eventCount += turn.events.length;
	}
	return kept.reverse();
}

function parseActivityTurn(value: unknown): ActivityTurn | null {
	if (!value || typeof value !== "object") return null;
	const turn = value as Partial<ActivityTurn>;
	if (
		turn.version !== 1 ||
		typeof turn.id !== "string" ||
		typeof turn.model !== "string" ||
		!isFiniteNonNegative(turn.startedAt) ||
		!isFiniteNonNegative(turn.durationMs) ||
		!isFiniteNonNegative(turn.toolCount) ||
		!isFiniteNonNegative(turn.toolTimeMs) ||
		!isFiniteNonNegative(turn.failureCount) ||
		!Array.isArray(turn.events)
	) return null;

	const events: ActivityEvent[] = [];
	for (const raw of turn.events.slice(0, MAX_EVENTS_PER_TURN)) {
		if (!raw || typeof raw !== "object") continue;
		const event = raw as Partial<ActivityEvent>;
		if (
			typeof event.toolCallId !== "string" ||
			typeof event.toolName !== "string" ||
			typeof event.preview !== "string" ||
			!isFiniteNonNegative(event.startedAt) ||
			!isFiniteNonNegative(event.offsetMs) ||
			!isFiniteNonNegative(event.durationMs) ||
			typeof event.failed !== "boolean"
		) continue;
		events.push({
			toolCallId: sanitizeLabel(event.toolCallId, 160),
			toolName: sanitizeLabel(event.toolName, 60),
			preview: sanitizeLabel(redactSecrets(event.preview), PREVIEW_LENGTH),
			startedAt: event.startedAt,
			offsetMs: event.offsetMs,
			durationMs: event.durationMs,
			failed: event.failed,
		});
	}

	return {
		version: 1,
		id: sanitizeLabel(turn.id, 160),
		model: sanitizeLabel(turn.model, 100),
		startedAt: turn.startedAt,
		durationMs: turn.durationMs,
		toolCount: Math.floor(turn.toolCount),
		toolTimeMs: turn.toolTimeMs,
		failureCount: Math.floor(turn.failureCount),
		droppedEvents: isFiniteNonNegative(turn.droppedEvents) ? Math.floor(turn.droppedEvents) : 0,
		events,
	};
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

class ActivityView {
	private readonly turns: ActivityTurn[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private readonly viewportRows: number;
	private scrollOffset = 0;
	private initialized = false;

	constructor(turns: ActivityTurn[], tui: TUI, theme: Theme, onClose: () => void) {
		this.turns = turns;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.viewportRows = Math.max(4, Math.min(22, tui.terminal.rows - 8));
	}

	handleInput(data: string): void {
		const rows = this.timelineRows();
		const maxOffset = Math.max(0, rows.length - this.viewportRows);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up")) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, "down")) this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "left")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportRows);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "right")) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.viewportRows);
		} else if (matchesKey(data, "home")) this.scrollOffset = 0;
		else if (matchesKey(data, "end")) this.scrollOffset = maxOffset;
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Activity", Math.max(0, width), "")];
		const safeWidth = width;
		const innerWidth = safeWidth - 2;
		const rows = this.timelineRows();
		const maxOffset = Math.max(0, rows.length - this.viewportRows);
		if (!this.initialized) {
			this.scrollOffset = maxOffset;
			this.initialized = true;
		}
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

		const border = (text: string) => this.theme.fg("border", text);
		const fit = (text: string) => truncateToWidth(text, innerWidth, "…", true);
		const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
		const title = this.theme.fg("accent", this.theme.bold(" Turn activity "));
		lines.push(border("│") + fit(`${title}${this.theme.fg("dim", `${this.turns.length} recent`)}`) + border("│"));
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));

		if (rows.length === 0) {
			lines.push(border("│") + fit(this.theme.fg("dim", " No completed turns in this branch.")) + border("│"));
		} else {
			const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportRows);
			for (const row of visible) lines.push(border("│") + fit(this.renderRow(row)) + border("│"));
		}

		const position = rows.length === 0 ? "0/0" : `${Math.min(rows.length, this.scrollOffset + 1)}-${Math.min(rows.length, this.scrollOffset + this.viewportRows)}/${rows.length}`;
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		lines.push(
			border("│") +
				fit(this.theme.fg("dim", ` ↑↓ scroll • PgUp/PgDn page • Home/End • q/Esc close  ${position}`)) +
				border("│"),
		);
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {}

	private timelineRows(): TimelineRow[] {
		const rows: TimelineRow[] = [];
		for (let index = 0; index < this.turns.length; index++) {
			const turn = this.turns[index];
			if (!turn) continue;
			rows.push({ kind: "turn", turn, number: index + 1 });
			for (const event of [...turn.events].sort((a, b) => a.startedAt - b.startedAt)) {
				rows.push({ kind: "event", event });
			}
			if (turn.events.length === 0) rows.push({ kind: "note", text: "    no tool calls" });
			if (turn.droppedEvents > 0) rows.push({ kind: "note", text: `    … ${turn.droppedEvents} additional tools omitted` });
		}
		return rows;
	}

	private renderRow(row: TimelineRow): string {
		if (row.kind === "note") return this.theme.fg("dim", row.text);
		if (row.kind === "turn") {
			const time = formatClock(row.turn.startedAt);
			return ` ${this.theme.fg("accent", this.theme.bold(`Turn ${row.number}`))} ${this.theme.fg("dim", time)}  ${formatSummary(row.turn)}`;
		}

		const event = row.event;
		const status = event.failed ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓");
		const offset = `+${formatDuration(event.offsetMs)}`.padStart(7);
		const time = formatClock(event.startedAt);
		const name = this.theme.fg("toolTitle", event.toolName);
		const preview = event.preview ? ` ${this.theme.fg("muted", event.preview)}` : "";
		const duration = this.theme.fg(event.failed ? "error" : "dim", formatDuration(event.durationMs));
		return `   ${this.theme.fg("dim", `${offset} ${time}`)} ${status} ${name}${preview}  ${duration}`;
	}
}

function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return [date.getHours(), date.getMinutes(), date.getSeconds()]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
}
