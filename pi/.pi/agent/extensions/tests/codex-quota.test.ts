import assert from "node:assert/strict";
import { detailText, weeklyPlan } from "../quota/openai-codex.ts";

// Run with TZ=UTC so the local calendar checkpoints are deterministic.
const monday = new Date(2026, 8, 21, 10);
const nextMonday = new Date(2026, 8, 28, 10).getTime() / 1000;
const fresh = { usedPercent: 0, leftPercent: 100, resetAt: nextMonday, windowSeconds: 7 * 86400, label: "7d" };
const plan = weeklyPlan(fresh, monday).join("\n");
assert.match(plan, /Now\s+—\s+—\s+0%\s+100%\s+7d/);
assert.match(plan, /Mon, Sep 21\s+8h\s+\+14%\s+14%/);
assert.match(plan, /Tue, Sep 22\s+8h\s+\+14%\s+28%/);
assert.match(plan, /Wed, Sep 23\s+8h\s+\+14%\s+42%/);
assert.match(plan, /Thu, Sep 24\s+8h\s+\+14%\s+56%/);
assert.match(plan, /Fri, Sep 25\s+8h\s+\+14%\s+70%/);
assert.match(plan, /Fri, Sep 25 eve\s+6h\s+\+10%\s+80%/);
assert.match(plan, /Sat, Sep 26\s+24h\s+\+10%\s+90%/);
assert.match(plan, /Sun, Sep 27\s+24h\s+\+10%\s+100%\s+0%/);
assert.doesNotMatch(plan, /Mon, Sep 28/); // Reset at 10:00, before work starts.
assert.match(plan, /no 18:00 deadline/);

// A Saturday-morning reset leaves a partial Saturday allocation, not a skipped day.
const tuesday = new Date(2026, 8, 15, 13, 6);
const saturdayReset = new Date(2026, 8, 19, 11, 6).getTime() / 1000;
const weekly = { ...fresh, usedPercent: 31, leftPercent: 69, resetAt: saturdayReset };
const partial = weeklyPlan(weekly, tuesday).join("\n");
assert.match(partial, /Tue, Sep 15\s+4\.9h\s+\+9\.2%\s+40\.2%/);
assert.match(partial, /Fri, Sep 18 eve\s+6h\s+\+10%\s+95\.4%/);
assert.match(partial, /Sat, Sep 19\s+11\.1h\s+\+4\.6%\s+100%/);

// Refreshes use actual remaining quota, including off-hours usage since the last check.
const refreshed = weeklyPlan({ ...weekly, usedPercent: 50, leftPercent: 50 }, new Date(2026, 8, 17, 13)).join("\n");
assert.match(refreshed, /Now\s+—\s+—\s+50%\s+50%/);
assert.match(refreshed, /Fri, Sep 18 eve\s+6h\s+\+10%/);
assert.match(refreshed, /Sat, Sep 19\s+11\.1h\s+\+4\.6%\s+100%/);

// After work, the remaining quota is apportioned to evening and weekend slots.
const fridayNight = weeklyPlan(weekly, new Date(2026, 8, 18, 20)).join("\n");
assert.doesNotMatch(fridayNight, /Fri, Sep 18\s+\d+h/);
assert.match(fridayNight, /Fri, Sep 18 eve\s+4h/);
assert.match(fridayNight, /Sat, Sep 19\s+11\.1h/);

// Reset during a workday only counts the hours before reset.
const midweek = weeklyPlan({ ...weekly, resetAt: new Date(2026, 8, 16, 13).getTime() / 1000 }, tuesday).join("\n");
assert.match(midweek, /Wed, Sep 16\s+3h/);
assert.doesNotMatch(midweek, /Thu, Sep 17/);

// Last-minute off-hours still report the remainder instead of implying it expired.
const noSlots = weeklyPlan({ ...weekly, resetAt: new Date(2026, 8, 16, 9).getTime() / 1000 }, new Date(2026, 8, 15, 20)).join("\n");
assert.match(noSlots, /No planned hours left; 69% remains usable until reset/);

const realNow = Date.now;
Date.now = () => tuesday.getTime();
try {
	const fiveHour = { usedPercent: 10, leftPercent: 90, resetAt: tuesday.getTime() / 1000 + 3600, windowSeconds: 5 * 3600, label: "5h" };
	const detail = detailText({ success: true, primary: fiveHour, secondary: weekly, raw: {}, fetchedAt: tuesday.getTime(), source: "test" }, tuesday);
	assert.match(detail, /pace: fresh 20%\/hour/);
	assert.match(detail, /Sat, Sep 19/);
	assert.doesNotMatch(detail, /pace: fresh 14\.3%\/day/);

	// ProLite reports the weekly quota in primary, not secondary.
	const proLite = detailText({ success: true, primary: weekly, raw: {}, fetchedAt: tuesday.getTime(), source: "test" }, tuesday);
	assert.match(proLite, /Weekly plan/);
	assert.match(proLite, /Fri, Sep 18 eve/);
	assert.match(proLite, /Sat, Sep 19/);
} finally {
	Date.now = realNow;
}

console.log("codex-quota weekly plan tests: ok");
