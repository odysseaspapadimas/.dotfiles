import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import responseTime, { formatDuration, formatSummary } from "../response-time.ts";

function harness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const notifications: Array<{ message: string; type: string }> = [];
	responseTime({
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand() { assert.fail("summary-only tracking must not register commands"); },
		appendEntry() { assert.fail("summary-only tracking must not persist history"); },
	} as unknown as ExtensionAPI);
	const ctx = {
		model: { id: "mock-model" } as { id?: string; name?: string } | undefined,
		hasUI: true,
		sessionManager: { getBranch() { assert.fail("summary-only tracking must not read session history"); } },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			custom() { assert.fail("summary-only tracking must not open an overlay"); },
		},
	};
	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { emit, ctx, notifications };
}

test("response durations and the existing summary format are preserved", () => {
	for (const [ms, expected] of [
		[0, "0ms"], [999, "999ms"], [1_250, "1.3s"], [10_000, "10s"],
		[61_000, "1m 1s"], [3_661_000, "1h 1m"], [-1, "0ms"], [NaN, "0ms"], [Infinity, "0ms"],
	] as const) assert.equal(formatDuration(ms), expected);
	assert.equal(formatSummary({ model: "mock-model", durationMs: 150, toolCount: 2, toolTimeMs: 140, failureCount: 1 }),
		"mock-model • 150ms • 2 tools • 140ms tool time • 1 failed");
});

test("parallel tools retain summed tool time and failures without reading arguments", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("session_start");
	await emit("agent_start");
	await emit("tool_execution_start", {
		toolCallId: "a",
		get args() { return assert.fail("tool arguments must not be inspected or retained"); },
	});
	now = 1_010;
	await emit("tool_execution_start", { toolCallId: "b" });
	now = 1_050;
	await emit("tool_execution_end", { toolCallId: "b", isError: true });
	now = 1_100;
	await emit("tool_execution_end", { toolCallId: "a", isError: false });
	// Duplicate and unmatched completion events must not inflate the totals.
	await emit("tool_execution_end", { toolCallId: "a", isError: true });
	await emit("tool_execution_end", { toolCallId: "unknown", isError: true });
	now = 1_150;
	await emit("agent_end");
	assert.deepEqual(notifications, [{
		message: "mock-model • 150ms • 2 tools • 140ms tool time • 1 failed", type: "warning",
	}]);
});

test("unfinished tools are counted as failed once when a run ends", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("agent_start");
	await emit("tool_execution_start", { toolCallId: "aborted" });
	now = 1_100;
	await emit("agent_end");
	await emit("tool_execution_end", { toolCallId: "aborted", isError: true });
	await emit("agent_end");
	assert.deepEqual(notifications, [{
		message: "mock-model • 100ms • 1 tools • 100ms tool time • 1 failed", type: "warning",
	}]);
});

test("each run starts fresh and runs without tools still produce a summary", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("agent_start");
	await emit("tool_execution_start", { toolCallId: "a" });
	now = 1_010;
	await emit("tool_execution_end", { toolCallId: "a", isError: true });
	await emit("agent_end");
	now = 2_000;
	await emit("agent_start");
	now = 2_150;
	await emit("agent_end");
	assert.deepEqual(notifications[1], {
		message: "mock-model • 150ms • 0 tools • 0ms tool time • 0 failed", type: "info",
	});
});

test("tools can start tracking without agent_start, including timestamp zero", async (t) => {
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("tool_execution_start", { toolCallId: "a" });
	now = 10;
	await emit("tool_execution_end", { toolCallId: "a", isError: false });
	await emit("agent_end");
	assert.deepEqual(notifications, [{
		message: "mock-model • 10ms • 1 tools • 10ms tool time • 0 failed", type: "info",
	}]);
});

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
	test(`${event} drops pending state without reading or writing history`, async (t) => {
		t.mock.method(Date, "now", () => 1_000);
		const { emit, notifications } = harness();
		await emit("agent_start");
		await emit("tool_execution_start", { toolCallId: "old" });
		await emit(event);
		await emit("tool_execution_end", { toolCallId: "old", isError: true });
		await emit("agent_end");
		assert.deepEqual(notifications, []);
		await emit("agent_start");
		await emit("agent_end");
		assert.deepEqual(notifications, [{
			message: "mock-model • 0ms • 0 tools • 0ms tool time • 0 failed", type: "info",
		}]);
	});
}

test("headless runs neither notify nor persist summaries", async () => {
	const { emit, ctx, notifications } = harness();
	ctx.hasUI = false;
	await emit("agent_start");
	await emit("tool_execution_start", { toolCallId: "a" });
	await emit("tool_execution_end", { toolCallId: "a", isError: false });
	await emit("agent_end");
	assert.deepEqual(notifications, []);
});

test("tool counts are not capped by the removed timeline limits", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("agent_start");
	for (let i = 0; i < 250; i++) {
		await emit("tool_execution_start", { toolCallId: String(i) });
		now++;
		await emit("tool_execution_end", { toolCallId: String(i), isError: false });
	}
	await emit("agent_end");
	assert.deepEqual(notifications, [{
		message: "mock-model • 250ms • 250 tools • 250ms tool time • 0 failed", type: "info",
	}]);
});

test("backward clock changes never produce negative durations", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const { emit, notifications } = harness();
	await emit("agent_start");
	await emit("tool_execution_start", { toolCallId: "a" });
	now = 900;
	await emit("tool_execution_end", { toolCallId: "a", isError: false });
	await emit("agent_end");
	assert.deepEqual(notifications, [{
		message: "mock-model • 0ms • 1 tools • 0ms tool time • 0 failed", type: "info",
	}]);
});

test("model naming falls back to the display name and then unknown", async (t) => {
	t.mock.method(Date, "now", () => 1_000);
	const { emit, ctx, notifications } = harness();
	ctx.model = { name: "Model Display Name" };
	await emit("agent_start");
	await emit("agent_end");
	ctx.model = undefined;
	await emit("agent_start");
	await emit("agent_end");
	assert.match(notifications[0].message, /^Model Display Name •/);
	assert.match(notifications[1].message, /^unknown •/);
});
