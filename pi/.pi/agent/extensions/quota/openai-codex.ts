/**
 * OpenAI Codex Quota Extension for Pi
 *
 * Shows the currently reported ChatGPT/Codex usage windows for the
 * `openai-codex` provider in Pi's footer.
 * Uses the same private endpoint the Codex web UI/tools use:
 *   https://chatgpt.com/backend-api/wham/usage
 *
 * Auth is read from ~/.pi/agent/auth.json under `openai-codex` (preferred),
 * or from ~/.codex/auth.json as a fallback. No extra setup is needed if Pi or
 * Codex CLI is already logged in.
 *
 * Commands:
 *   /codex-quota          Show detailed quota
 *   /codex-quota refresh  Bypass cache
 *   /codex-quota json     Show normalized JSON
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodexAuthConfig {
	accessToken: string;
	accountId?: string;
	source: string;
}

interface UsageWindow {
	usedPercent: number;
	leftPercent: number;
	resetAt: number;
	windowSeconds: number;
	label: string;
}

interface CodexUsageResult {
	success: true;
	planType?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	codeReview?: UsageWindow;
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: number;
	};
	raw: unknown;
	fetchedAt: number;
	source: string;
}

interface CodexUsageError {
	success: false;
	error: string;
	status?: number;
}

type CodexUsageResponse = CodexUsageResult | CodexUsageError;

const STATUS_KEY = "openai-codex-quota";
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_TTL_MS = 3 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

let lastResult: CodexUsageResponse | null = null;
let lastFetchAt = 0;

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function tokenFromEntry(entry: unknown): { accessToken: string; accountId?: string } | null {
	if (!entry || typeof entry !== "object") return null;
	const obj = entry as Record<string, unknown>;
	const accessToken =
		typeof obj.access === "string" ? obj.access.trim()
		: typeof obj.access_token === "string" ? obj.access_token.trim()
		: "";
	if (!accessToken) return null;
	const accountId =
		typeof obj.accountId === "string" ? obj.accountId.trim()
		: typeof obj.account_id === "string" ? obj.account_id.trim()
		: undefined;
	return { accessToken, accountId };
}

function readCodexConfig(): CodexAuthConfig | null {
	const envToken = process.env.OPENAI_CODEX_ACCESS_TOKEN?.trim();
	if (envToken) {
		return {
			accessToken: envToken,
			accountId: process.env.OPENAI_CODEX_ACCOUNT_ID?.trim() || undefined,
			source: "env",
		};
	}

	const piAuth = readJson(join(getAgentDir(), "auth.json"));
	const piCodex = tokenFromEntry(piAuth?.["openai-codex"]);
	if (piCodex) return { ...piCodex, source: "pi auth.json" };

	const cliAuth = readJson(join(homedir(), ".codex", "auth.json"));
	const cliCodex = tokenFromEntry(cliAuth);
	if (cliCodex) return { ...cliCodex, source: "~/.codex/auth.json" };

	return null;
}

function windowLabel(windowSeconds: number, fallback: string): string {
	if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return fallback;
	const days = windowSeconds / 86400;
	if (Number.isInteger(days)) return `${days}d`;
	const hours = windowSeconds / 3600;
	if (Number.isInteger(hours)) return `${hours}h`;
	const minutes = windowSeconds / 60;
	if (Number.isInteger(minutes)) return `${minutes}m`;
	return fallback;
}

function normalizeWindow(raw: unknown, fallbackLabel: string): UsageWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const used = Number(obj.used_percent ?? obj.usedPercent);
	const resetAt = Number(obj.reset_at ?? obj.resetAt);
	const rawWindowSeconds = Number(obj.limit_window_seconds ?? obj.windowDurationSeconds ?? obj.window_seconds);
	if (!Number.isFinite(used) || !Number.isFinite(resetAt)) return undefined;
	const windowSeconds = Number.isFinite(rawWindowSeconds) ? rawWindowSeconds : 0;
	return {
		usedPercent: Math.max(0, used),
		leftPercent: Math.max(0, 100 - used),
		resetAt,
		windowSeconds,
		label: windowLabel(windowSeconds, fallbackLabel),
	};
}

function normalizeUsage(raw: unknown, auth: CodexAuthConfig): CodexUsageResult {
	const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const rateLimit = (obj.rate_limit && typeof obj.rate_limit === "object" ? obj.rate_limit : {}) as Record<string, unknown>;
	const codeReview = (obj.code_review_rate_limit && typeof obj.code_review_rate_limit === "object" ? obj.code_review_rate_limit : {}) as Record<string, unknown>;
	const credits = obj.credits && typeof obj.credits === "object" ? obj.credits as Record<string, unknown> : undefined;

	return {
		success: true,
		planType: typeof obj.plan_type === "string" ? obj.plan_type : undefined,
		primary: normalizeWindow(rateLimit.primary_window, "primary"),
		secondary: normalizeWindow(rateLimit.secondary_window, "secondary"),
		codeReview: normalizeWindow(codeReview.primary_window, "review"),
		credits: credits ? {
			hasCredits: typeof credits.has_credits === "boolean" ? credits.has_credits : undefined,
			unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
			balance: typeof credits.balance === "number" ? credits.balance : undefined,
		} : undefined,
		raw,
		fetchedAt: Date.now(),
		source: auth.source,
	};
}

async function fetchCodexUsage(force = false, signal?: AbortSignal): Promise<CodexUsageResponse> {
	if (!force && lastResult && Date.now() - lastFetchAt < CACHE_TTL_MS) return lastResult;

	const auth = readCodexConfig();
	if (!auth) {
		lastResult = { success: false, error: "No Codex OAuth token found" };
		lastFetchAt = Date.now();
		return lastResult;
	}

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.accessToken}`,
			Accept: "application/json",
			"User-Agent": "pi-openai-codex-quota/1.0",
		};
		if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

		const response = await fetch(USAGE_ENDPOINT, {
			headers,
			signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) {
			lastResult = { success: false, status: response.status, error: `Usage endpoint returned ${response.status}` };
			lastFetchAt = Date.now();
			return lastResult;
		}
		lastResult = normalizeUsage(await response.json(), auth);
		lastFetchAt = Date.now();
		return lastResult;
	} catch (err) {
		lastResult = { success: false, error: err instanceof Error ? err.message : String(err) };
		lastFetchAt = Date.now();
		return lastResult;
	}
}

function formatReset(resetAt: number): string {
	const sec = Math.max(0, resetAt - Math.floor(Date.now() / 1000));
	const days = Math.floor(sec / 86400);
	const hours = Math.floor((sec % 86400) / 3600);
	const mins = Math.floor((sec % 3600) / 60);
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	return `${mins}m`;
}

function pct(n: number): string {
	return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

function compactWindow(w: UsageWindow): string {
	return `${w.label}:${pct(w.usedPercent)}%/${formatReset(w.resetAt)}`;
}

function statusText(result: CodexUsageResponse): string | undefined {
	if (!result.success) return `Codex ⚠ ${result.error.length > 24 ? result.error.slice(0, 21) + "..." : result.error}`;
	const parts = [result.primary, result.secondary].filter(Boolean).map((w) => compactWindow(w!));
	return parts.length ? `Codex ${parts.join(" ")}` : "Codex no usage data";
}

interface PaceInfo {
	unitName: "day" | "hour";
	boundaryName: "today" | "this hour" | "until reset";
	targetSuffix: "by midnight" | "by next hour" | "by reset";
	freshBudget: number;
	usedAverage?: number;
	useFromNow?: number;
	leftThisUnit: number;
	currentUnitTarget: number;
}

function paceInfo(w: UsageWindow): PaceInfo | undefined {
	if (!w.windowSeconds || w.windowSeconds <= 0) return undefined;
	const now = new Date();
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const resetSeconds = Math.max(0, w.resetAt - nowSeconds);
	const elapsedSeconds = Math.max(0, w.windowSeconds - resetSeconds);
	const unitSeconds = w.windowSeconds >= 86400 ? 86400 : 3600;
	const unitName = w.windowSeconds >= 86400 ? "day" : "hour";
	const windowUnits = w.windowSeconds / unitSeconds;
	const unitsLeft = resetSeconds / unitSeconds;
	const unitsElapsed = elapsedSeconds / unitSeconds;
	if (windowUnits <= 0) return undefined;
	const boundaryAt = Math.min(w.resetAt, nextLocalBoundarySeconds(unitName, now));
	const windowStartAt = w.resetAt - w.windowSeconds;
	const currentUnitTarget = Math.max(0, Math.min(100, ((boundaryAt - windowStartAt) / w.windowSeconds) * 100));
	const resetsBeforeBoundary = boundaryAt >= w.resetAt;
	return {
		unitName,
		boundaryName: resetsBeforeBoundary ? "until reset" : unitName === "day" ? "today" : "this hour",
		targetSuffix: resetsBeforeBoundary ? "by reset" : unitName === "day" ? "by midnight" : "by next hour",
		freshBudget: 100 / windowUnits,
		usedAverage: unitsElapsed > 0 ? w.usedPercent / unitsElapsed : undefined,
		useFromNow: unitsLeft > 0 ? w.leftPercent / unitsLeft : undefined,
		leftThisUnit: Math.max(0, currentUnitTarget - w.usedPercent),
		currentUnitTarget,
	};
}

function nextLocalBoundarySeconds(unitName: "day" | "hour", now: Date): number {
	const boundary = new Date(now);
	if (unitName === "day") boundary.setHours(24, 0, 0, 0);
	else boundary.setHours(now.getHours() + 1, 0, 0, 0);
	return Math.floor(boundary.getTime() / 1000);
}

function detailText(result: CodexUsageResult): string {
	const lines: string[] = [];
	if (result.planType) lines.push(`  Plan:        ${result.planType}`);
	for (const w of [result.primary, result.secondary, result.codeReview].filter(Boolean) as UsageWindow[]) {
		lines.push(`  ${w.label.padEnd(11)} ${pct(w.usedPercent).padStart(5)}% used, ${pct(w.leftPercent)}% left (resets in ${formatReset(w.resetAt)})`);
		const pace = paceInfo(w);
		if (pace) {
			const avg = pace.usedAverage === undefined ? "—" : `${pct(pace.usedAverage)}%/${pace.unitName}`;
			const now = pace.useFromNow === undefined ? "—" : `${pct(pace.useFromNow)}%/${pace.unitName}`;
			lines.push(`              pace: fresh ${pct(pace.freshBudget)}%/${pace.unitName}, avg ${avg}, now ${now}`);
			lines.push(`              ${pace.boundaryName}: +${pct(pace.leftThisUnit)}% more -> target ${pct(pace.currentUnitTarget)}% used ${pace.targetSuffix}`);
		}
	}
	if (result.credits?.hasCredits) {
		const bal = typeof result.credits.balance === "number" ? result.credits.balance.toFixed(2) : "unknown";
		lines.push(`  Credits:     ${result.credits.unlimited ? "unlimited" : bal}`);
	}
	lines.push(`  Auth:        ${result.source}`);
	return lines.join("\n");
}

function isOpenAICodexModel(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === "openai-codex";
}

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let isActive = false;
	let capturedUi: { setStatus: (key: string, text: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } | null = null;

	async function refresh(force = false, signal?: AbortSignal): Promise<void> {
		const result = await fetchCodexUsage(force, signal);
		if (!isActive || !capturedUi) return;
		const text = statusText(result);
		capturedUi.setStatus(STATUS_KEY, text ? capturedUi.theme.fg("dim", text) : undefined);
	}

	function activate(ui: typeof capturedUi): void {
		capturedUi = ui;
		isActive = true;
		refresh(false).catch(() => {});
		if (!refreshTimer) refreshTimer = setInterval(() => refresh(false).catch(() => {}), REFRESH_INTERVAL_MS);
	}

	function deactivate(): void {
		isActive = false;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = null;
		capturedUi?.setStatus(STATUS_KEY, undefined);
		capturedUi = null;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) activate(ctx.ui);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) activate(ctx.ui);
		else deactivate();
	});

	pi.on("after_provider_response", async (_event, ctx) => {
		if (isActive && isOpenAICodexModel(ctx.model)) setTimeout(() => refresh(true).catch(() => {}), 1500);
	});

	pi.on("session_shutdown", async () => deactivate());

	pi.registerCommand("codex-quota", {
		description: "Show the current OpenAI Codex quota window",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Codex fetching..."));
			const result = await fetchCodexUsage(mode === "refresh" || mode === "raw" || mode === "json");
			const text = statusText(result);
			ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("dim", text) : undefined);

			if (!result.success) {
				ctx.ui.notify(`Codex quota error: ${result.error}`, "error");
				return;
			}

			if (mode === "json" || mode === "raw") {
				ctx.ui.notify(JSON.stringify(mode === "raw" ? result.raw : result, null, 2), "info");
				return;
			}

			ctx.ui.notify("OpenAI Codex Quota\n" + detailText(result), "info");
		},
	});
}
