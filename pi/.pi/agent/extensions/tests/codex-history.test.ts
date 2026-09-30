import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dailyHistoryText, dailyPiCodexTokens, dailyQuota, loadQuotaSamples, localDay, quotaHistoryFile, recordQuotaSample,
} from "../quota/history.ts";

// Run with TZ=UTC to make the local-day tests deterministic.
const root = await mkdtemp(join(tmpdir(), "pi-codex-history-"));
const resetAt = Date.UTC(2026, 8, 28, 10) / 1000;
try {
	const file = quotaHistoryFile(root, "account-private-id", resetAt);
	assert.doesNotMatch(file, /account-private-id/);
	const first = Date.UTC(2026, 8, 24, 23, 55);
	const second = Date.UTC(2026, 8, 24, 23, 59);
	const third = Date.UTC(2026, 8, 25, 0, 5);
	assert.equal(localDay(first), "2026-09-24");
	await recordQuotaSample(file, { at: first, resetAt, usedPercent: 40 });
	await recordQuotaSample(file, { at: second, resetAt, usedPercent: 42 });
	await recordQuotaSample(file, { at: third, resetAt, usedPercent: 45 });
	const stored = await readFile(file, "utf8");
	assert.doesNotMatch(stored, /account-private-id/);
	const samples = await loadQuotaSamples(file);
	assert.equal(samples.length, 3);
	const daily = dailyQuota(samples, resetAt, 7 * 86400, third + 1000);
	assert.equal(daily.get("2026-09-24")?.increase, 2);
	assert.equal(daily.get("2026-09-25")?.increase, 3); // Gap across midnight: estimated, assigned to later sample.
	assert.equal(daily.get("2026-09-25")?.usedPercent, 45);
	assert.equal(dailyQuota(samples, resetAt + 1, 7 * 86400, third + 1000).size, 0); // New reset window.
	await writeFile(file, `${stored}invalid line\n`);
	assert.equal((await loadQuotaSamples(file)).length, 3);

	const sessions = join(root, "sessions");
	await mkdir(join(sessions, "one"), { recursive: true });
	await mkdir(join(sessions, "fork"), { recursive: true });
	const message = (id: string, at: number, provider: string, usage: object) => JSON.stringify({
		type: "message", id, timestamp: new Date(at).toISOString(),
		message: { role: "assistant", provider, usage },
	});
	const baseUsage = { input: 100, output: 50, cacheRead: 300, cacheWrite: 0, totalTokens: 450 };
	const oldSession = join(sessions, "one", "older-started-session.jsonl");
	await writeFile(oldSession, [
		message("a", first, "openai-codex", baseUsage),
		message("b", third, "openai-codex", { ...baseUsage, input: 200, totalTokens: 550 }),
		message("c", third, "anthropic", baseUsage),
		JSON.stringify({ type: "usage", id: "d", timestamp: new Date(third).toISOString(), provider: "openai-codex", usage: baseUsage }),
		JSON.stringify({ type: "compaction", id: "e", timestamp: new Date(third).toISOString(), usage: baseUsage }),
		"invalid json",
	].join("\n") + "\n");
	await writeFile(join(sessions, "fork", "copied.jsonl"), message("a", first, "openai-codex", baseUsage) + "\n");
	const piTokens = await dailyPiCodexTokens(sessions, first - 1000, third + 1000);
	assert.deepEqual(piTokens.get("2026-09-24"), { input: 100, output: 50, cacheRead: 300, cacheWrite: 0, total: 450 });
	assert.deepEqual(piTokens.get("2026-09-25"), { input: 300, output: 100, cacheRead: 600, cacheWrite: 0, total: 1000 });
	const output = dailyHistoryText(first, third, daily, piTokens);
	assert.match(output, /Thu, Sep 24\s+~\+2\.0%\s+42\.0%\s+450 \(100 \/ 50 \/ 300\)/);
	assert.match(output, /Fri, Sep 25\s+~\+3\.0%\s+45\.0%\s+1,000 \(300 \/ 100 \/ 600\)/);
	assert.match(output, /Quota covers the account; tokens count Pi Codex responses only/);

	// Ignore files with no changes since the start of the interval.
	await utimes(oldSession, new Date(first - 100_000), new Date(first - 100_000));
	const later = await dailyPiCodexTokens(sessions, first - 1000, third + 1000);
	assert.equal(later.get("2026-09-25"), undefined);
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log("codex daily history tests: ok");
