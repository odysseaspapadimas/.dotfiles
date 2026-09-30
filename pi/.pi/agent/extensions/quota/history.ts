import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

export interface QuotaSample {
	at: number; // Unix milliseconds
	resetAt: number; // Unix seconds
	usedPercent: number;
}

export interface DailyQuota {
	usedPercent?: number;
	increase?: number; // Observed increase; cannot reconstruct periods without samples.
}

export interface DailyTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export function localDay(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Never persist the account ID or OAuth token alongside usage data.
export function quotaHistoryFile(agentDir: string, accountId: string | undefined, resetAt: number): string {
	const accountKey = accountId ? createHash("sha256").update(accountId).digest("hex").slice(0, 16) : "unknown-account";
	return join(agentDir, "quota-history", accountKey, `${resetAt}.jsonl`);
}

export async function recordQuotaSample(file: string, sample: QuotaSample): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await appendFile(file, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
}

export async function loadQuotaSamples(file: string): Promise<QuotaSample[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const samples: QuotaSample[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const sample = JSON.parse(line) as QuotaSample;
			if (Number.isFinite(sample.at) && Number.isFinite(sample.resetAt) && Number.isFinite(sample.usedPercent) && sample.usedPercent >= 0) samples.push(sample);
		} catch { /* Ignore a truncated or corrupt sample, not the rest of the history. */ }
	}
	return samples.sort((a, b) => a.at - b.at);
}

export function dailyQuota(samples: QuotaSample[], resetAt: number, windowSeconds: number, now: number): Map<string, DailyQuota> {
	const start = resetAt * 1000 - windowSeconds * 1000;
	const valid = samples.filter((s) => s.resetAt === resetAt && s.at >= start && s.at <= now).sort((a, b) => a.at - b.at);
	const rows = new Map<string, DailyQuota>();
	let previous: QuotaSample | undefined;
	for (const sample of valid) {
		const day = localDay(sample.at);
		const row = rows.get(day) ?? {};
		row.usedPercent = sample.usedPercent;
		rows.set(day, row);
		if (previous && sample.usedPercent >= previous.usedPercent) {
			const increase = sample.usedPercent - previous.usedPercent;
			row.increase = (row.increase ?? 0) + increase;
			// A cross-midnight gap is attributed to the later sample's day, not claimed exact.
		}
		previous = sample;
	}
	return rows;
}

/** Sum Pi-recorded Codex responses across all local sessions (not Codex CLI/web usage). */
export async function dailyPiCodexTokens(sessionsDir: string, startMs: number, endMs: number): Promise<Map<string, DailyTokens>> {
	const totals = new Map<string, DailyTokens>();
	const seenEntries = new Set<string>(); // Forked sessions may contain copies of earlier entries.
	let directories;
	try { directories = await readdir(sessionsDir, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return totals;
		throw error;
	}
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const parent = join(sessionsDir, directory.name);
		let files;
		try { files = await readdir(parent, { withFileTypes: true }); }
		catch { continue; } // A session directory may disappear while scanning.
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			const path = join(parent, file.name);
			let info;
			try { info = await stat(path); }
			catch { continue; }
			if (info.mtimeMs < startMs) continue; // Long-running older sessions may still be active.
			const stream = createReadStream(path, { encoding: "utf8" });
			const lines = createInterface({ input: stream, crlfDelay: Infinity });
			try {
				for await (const line of lines) {
					if (!line.includes('"openai-codex"') || !line.includes('"usage"')) continue;
					let entry: any;
					try { entry = JSON.parse(line); } catch { continue; }
					let usage: any;
					let provider: string | undefined;
					if (entry.type === "message" && entry.message?.role === "assistant") {
						provider = entry.message.provider;
						usage = entry.message.usage;
					} else if (entry.type === "usage") {
						provider = entry.provider;
						usage = entry.usage;
					} else if (entry.type === "compaction" || entry.type === "branch_summary") {
						// These entries lack reliable provider attribution; don't guess or double-count.
						continue;
					}
					if (provider !== "openai-codex" || !usage) continue;
					const at = Date.parse(entry.timestamp);
					if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
					if (typeof entry.id === "string") {
						if (seenEntries.has(entry.id)) continue;
						seenEntries.add(entry.id);
					}
					const day = localDay(at);
					const total = totals.get(day) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					for (const [key, field] of [["input", "input"], ["output", "output"], ["cacheRead", "cacheRead"], ["cacheWrite", "cacheWrite"], ["total", "totalTokens"]] as const) {
						const amount = usage[field];
						if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) total[key] += amount;
					}
					totals.set(day, total);
				}
			} finally { lines.close(); stream.destroy(); }
		}
	}
	return totals;
}

export function dailyHistoryText(
	startMs: number, nowMs: number, quota: Map<string, DailyQuota>, tokens: Map<string, DailyTokens>,
): string {
	const rows = [
		"  Daily history (local days; current quota window):",
		"  Day          Quota Δ  Used     Pi tokens  (input / output / cache read)",
	];
	const date = new Date(startMs);
	date.setHours(0, 0, 0, 0);
	for (let i = 0; i < 9 && date.getTime() <= nowMs; i++) {
		const key = localDay(date.getTime());
		const q = quota.get(key);
		const t = tokens.get(key);
		const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
		const delta = q?.increase === undefined ? "—" : `~+${q.increase.toFixed(1)}%`;
		const used = q?.usedPercent === undefined ? "—" : `${q.usedPercent.toFixed(1)}%`;
		const tokenText = t ? `${formatTokens(t.total)} (${formatTokens(t.input)} / ${formatTokens(t.output)} / ${formatTokens(t.cacheRead)})` : "—";
		rows.push(`  ${day.padEnd(12)} ${delta.padStart(7)} ${used.padStart(6)}  ${tokenText}`);
		date.setDate(date.getDate() + 1);
	}
	rows.push("  ~ observed between samples; cross-midnight gaps count on the later day.");
	rows.push("  — = no baseline/data; % history starts when tracking begins (Pi must be running).");
	rows.push("  Quota covers the account; tokens count Pi Codex responses only, not CLI/web.");
	rows.push("  Unattributed compaction tokens excluded. Token totals do not convert to quota %.");
	return rows.join("\n");
}

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}
