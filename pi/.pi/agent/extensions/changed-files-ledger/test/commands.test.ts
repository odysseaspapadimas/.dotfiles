import assert from "node:assert/strict";
import test from "node:test";
import {
  RESTORE_ACTIONS,
  RESTORE_COMMANDS,
  TURN_RESTORE_ACTIONS,
  checkpointActions,
  checkpointDisplayName,
  parseCheckpointPromotion,
  formatCheckpointStorage,
  formatRecoveryHistory,
  formatRestorationAudit,
  formatRestoreActionSummary,
  recoveryPruneDisclosure,
  formatTimelineAge,
  formatTimelineItem,
  normalizeUserExcerpt,
  triggeringUserMessage,
} from "../index.js";
import type { Checkpoint, CheckpointStorageReport, TurnRecord } from "../src/ledger.js";

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "automatic-1234567890abcdef",
    kind: "automatic",
    createdAt: "2026-01-02T03:04:05.000Z",
    snapshot: { id: "snapshot", createdAt: "2026-01-02T03:04:05.000Z", files: {} },
    ...overrides,
  };
}

test("checkpoint promotion command parsing and picker action follow conventions", () => {
  assert.deepEqual(parseCheckpointPromotion("promote automatic-123 release candidate"), { id: "automatic-123", name: "release candidate" });
  assert.deepEqual(parseCheckpointPromotion(" promote automatic-123 "), { id: "automatic-123" });
  assert.equal(parseCheckpointPromotion("promote"), undefined);
  assert.deepEqual(checkpointActions(checkpoint()), ["Restore checkpoint", "Promote to named checkpoint", "Delete checkpoint", "Cancel"]);
  assert.deepEqual(checkpointActions(checkpoint({ kind: "named", name: "kept" })), ["Restore checkpoint", "Delete checkpoint", "Cancel"]);
});

test("checkpoint labels distinguish names from automatic safety points", () => {
  assert.equal(checkpointDisplayName(checkpoint({ kind: "named", name: "before refactor" })), "before refactor");
  assert.equal(checkpointDisplayName(checkpoint()), "safety 567890abcdef");
  assert.equal(checkpointDisplayName(checkpoint({ sourceLabel: "Before restoring response to “fix auth”" })), "Before restoring response to “fix auth”");
});

test("timeline formatting visibly distinguishes agent work and durable landmarks", () => {
  const turn: TurnRecord = {
    id: "0-1", turnIndex: 0, startedAt: "2026-01-02T03:00:00.000Z", endedAt: "2026-01-02T03:04:05.000Z",
    before: checkpoint().snapshot, after: checkpoint().snapshot, stats: { files: 2, additions: 3, deletions: 1, binary: 0 },
  };
  assert.match(formatTimelineItem({ kind: "turn", turn }).label, /^Agent-work turn #1 · \d+d$/);
  const linked = formatTimelineItem({ kind: "turn", turn: { ...turn, source: { entryId: "user-1", excerpt: "Fix the authentication race" } } });
  assert.match(linked.label, /^“Fix the authentication race” · 2f · \+3 −1/);
  assert.match(linked.description, /^Agent-work turn #1 ·/);
  assert.match(formatTimelineItem({ kind: "checkpoint", checkpoint: checkpoint({ kind: "named", name: "landmark" }) }).label, /^◆ Named checkpoint · landmark · \d+d$/);
  assert.match(formatTimelineItem({ kind: "checkpoint", checkpoint: checkpoint() }).label, /^◇ Safety checkpoint · safety/);
  assert.match(formatTimelineItem({ kind: "checkpoint", checkpoint: checkpoint({ sourceLabel: "Before restoring response to “fix auth”", sourceId: "turn-1" }) }).label, /^◇ Safety checkpoint · Before restoring response to “fix auth” · /);
  const now = Date.parse("2026-01-04T03:04:05.000Z");
  assert.equal(formatTimelineAge(now - 23 * 60_000, now), "23m");
  assert.equal(formatTimelineAge(now - 60 * 60_000, now), "1h");
  assert.equal(formatTimelineAge(now - 24 * 60 * 60_000, now), "24h");
  assert.equal(formatTimelineAge(now - 72 * 60 * 60_000, now), "3d");
});

test("restore aliases, explicit turn actions, and visible audit copy are stable", () => {
  assert.deepEqual(RESTORE_COMMANDS, ["rollback", "restore"]);
  assert.deepEqual(TURN_RESTORE_ACTIONS, ["Undo changes from this response", "Restore state after this response"]);
  assert.deepEqual(RESTORE_ACTIONS, ["Restore now", "Preview in Hunk", "Cancel"]);
  assert.equal(formatRestorationAudit({ target: "pre-state of agent-work turn #2", action: "undo", divergenceFiles: 3, safetyCheckpoint: "automatic-1" }),
    "Undid: pre-state of agent-work turn #2\nExternal/unrecorded divergence: 3 tracked-scope file(s) · safety: automatic-1");
});

test("restore action summary discloses actual-current stats, divergence, scope, and safety behavior", () => {
  const current = checkpoint().snapshot;
  const target = { ...checkpoint().snapshot, id: "target" };
  const summary = formatRestoreActionSummary(
    { id: "turn-2", label: "changes from response to “fix auth”", action: "undo", snapshot: target },
    {
      target: { id: "turn-2", label: "changes from response to “fix auth”", action: "undo", snapshot: target },
      current,
      divergence: { files: 1, additions: 2, deletions: 3, binary: 0 },
      scope: { id: "restore", label: "restore", before: current, after: target, stats: { files: 4, additions: 5, deletions: 6, binary: 0 } },
    },
  );
  assert.match(summary, /Restore target: changes from response/);
  assert.match(summary, /Actual current → target: 4f · \+5 −6/);
  assert.match(summary, /External\/unrecorded divergence: 1f · \+2 −3/);
  assert.match(summary, /Ignored files, submodule contents, directories, and special files are excluded/);
  assert.match(summary, /automatic checkpoint.*restores exactly, verifies, and records an audit marker/);
});

test("normalizes message excerpts without retaining bodies", () => {
  assert.equal(normalizeUserExcerpt("  hello\n\tworld  "), "hello world");
  assert.equal(normalizeUserExcerpt([{ type: "image", data: "large" }, { type: "text", text: "  visible   text " }]), "visible text");
  const long = normalizeUserExcerpt("x".repeat(200))!;
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith("…"));
  assert.equal(normalizeUserExcerpt([{ type: "image", data: "ignored" }]), undefined);
});

test("extracts causal user entries across steering, retry, compaction, and no-message runs", () => {
  const user = { type: "message", id: "user-stable", message: { role: "user", content: "Initial task" } };
  assert.deepEqual(triggeringUserMessage([user]), { entryId: "user-stable", excerpt: "Initial task" });
  assert.deepEqual(triggeringUserMessage([user, { type: "message", id: "assistant", message: { role: "assistant", content: [] } }]), { entryId: "user-stable", excerpt: "Initial task" });
  assert.deepEqual(triggeringUserMessage([user, { type: "compaction" }, { type: "message", id: "steer", message: { role: "user", content: "Steer this way" } }]), { entryId: "steer", excerpt: "Steer this way" });
  assert.deepEqual(triggeringUserMessage([user, { type: "custom_message", id: "injected-context" }]), { entryId: "user-stable", excerpt: "Initial task" });
  assert.equal(triggeringUserMessage([user, { type: "message", id: "done", message: { role: "assistant", content: [] } }, { type: "custom_message", id: "synthetic" }]), undefined);
  assert.equal(triggeringUserMessage([]), undefined);
});

test("recovery history status and prune disclosure name every preserved category", () => {
  const report = { agentTurns: 7, restorationAudits: 2, automaticCheckpoints: 3, namedCheckpoints: 4 };
  assert.equal(formatRecoveryHistory(report),
    "7 agent-turn restoration target(s), 2 restoration audit(s). 3 safety and 4 named checkpoint(s) are separate and retained.");
  assert.equal(recoveryPruneDisclosure(report),
    "Delete 7 agent-turn restoration target(s) and 2 restoration audit record(s). This cannot be undone. All 3 safety and 4 named checkpoint(s) are preserved; diff review scopes are unchanged.");
});

test("checkpoint storage reporting includes counts and readable physical size", () => {
  const report: CheckpointStorageReport = {
    checkpoints: 5,
    named: 2,
    automatic: 3,
    namedBytes: 1_572_864,
    warningBytes: 250 * 1024 * 1024,
    warning: false,
  };
  assert.equal(formatCheckpointStorage(report), "5 total (2 named, 3 safety) · 1.5 MiB named storage");
});
