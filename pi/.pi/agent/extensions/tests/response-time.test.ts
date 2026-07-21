import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activityProfiler, {
	boundTurns,
	formatDuration,
	sanitizeArgumentPreview,
	type ActivityTurn,
} from "../response-time.ts";

assert.equal(formatDuration(999), "999ms");
assert.equal(formatDuration(1_250), "1.3s");
assert.equal(formatDuration(61_000), "1m 1s");

const secretPreview = sanitizeArgumentPreview({
	command: "curl -H 'Authorization: Bearer top-secret' 'https://example.test/?token=also-secret' --password hunter2",
});
assert.match(secretPreview, /^command=/);
assert.doesNotMatch(secretPreview, /top-secret|also-secret|hunter2/);
assert.match(secretPreview, /\[REDACTED\]/);
assert.equal(sanitizeArgumentPreview({ path: "/tmp/example.ts", content: "must not be stored" }), "path=/tmp/example.ts");
assert.equal(sanitizeArgumentPreview({ content: "full payload" }), "");

const makeTurn = (index: number, eventCount = 1): ActivityTurn => ({
	version: 1,
	id: `turn-${index}`,
	model: "test-model",
	startedAt: index,
	durationMs: 10,
	toolCount: eventCount,
	toolTimeMs: eventCount,
	failureCount: 0,
	droppedEvents: 0,
	events: Array.from({ length: eventCount }, (_, eventIndex) => ({
		toolCallId: `${index}-${eventIndex}`,
		toolName: "read",
		preview: "path=/tmp/test",
		startedAt: index,
		offsetMs: 0,
		durationMs: 1,
		failed: false,
	})),
});
assert.equal(boundTurns(Array.from({ length: 50 }, (_, index) => makeTurn(index))).length, 40);
assert.equal(boundTurns([makeTurn(1, 250), makeTurn(2, 250), makeTurn(3, 250)]).length, 1);

const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const appended: Array<{ customType: string; data: ActivityTurn }> = [];
const fakePi = {
	on(name: string, handler: (event: any, ctx: any) => unknown) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
	},
	registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
		commands.set(name, command);
	},
	appendEntry(customType: string, data: ActivityTurn) {
		appended.push({ customType, data });
	},
};
activityProfiler(fakePi as unknown as ExtensionAPI);

const notifications: Array<{ message: string; type: string }> = [];
let branch: any[] = [];
const ctx = {
	model: { id: "mock-model" },
	hasUI: true,
	mode: "tui",
	sessionManager: { getBranch: () => branch },
	ui: {
		notify: (message: string, type: string) => notifications.push({ message, type }),
		custom: async (factory: any) => {
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, () => {});
			const lines = component.render(100) as string[];
			assert.ok(lines.every((line) => line.length <= 100));
			return undefined;
		},
	},
};

const emit = async (name: string, event: any = {}) => {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};

const realNow = Date.now;
let now = 1_000;
Date.now = () => now;
try {
	await emit("session_start");
	await emit("agent_start");
	await emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "echo ok" } });
	now = 1_010;
	await emit("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "/tmp/file" } });
	now = 1_050;
	await emit("tool_execution_end", { toolCallId: "b", toolName: "read", isError: true });
	now = 1_100;
	await emit("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: false });
	now = 1_150;
	await emit("agent_end");
} finally {
	Date.now = realNow;
}

assert.equal(appended.length, 1);
const recorded = appended[0]!.data;
assert.equal(recorded.toolCount, 2);
assert.equal(recorded.toolTimeMs, 140);
assert.equal(recorded.failureCount, 1);
assert.deepEqual(recorded.events.map((event) => event.toolCallId), ["a", "b"]);
assert.deepEqual(recorded.events.map((event) => event.durationMs), [100, 40]);
assert.equal(notifications[0]!.type, "warning");
assert.match(notifications[0]!.message, /mock-model • 150ms • 2 tools • 140ms tool time • 1 failed/);

// Reload/tree reconstruction must use only profiler entries on the active branch.
branch = [{ type: "custom", customType: "turn-activity-v1", data: makeTurn(99) }];
await emit("session_tree");
await commands.get("activity")!.handler("", ctx);

console.log("response-time activity profiler tests: ok");
