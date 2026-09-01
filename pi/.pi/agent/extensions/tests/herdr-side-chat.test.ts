import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasUnhandedWork,
  inheritedMainChatOpening,
  markInheritedMainChatMessage,
  sideChatBoundaryMessage,
  sideChatContextNotice,
  sideStatusLabel,
} from "../herdr-side-chat.ts";

test("side-chat context identifies the boundary and shared working directory", () => {
  const snapshotAt = Date.parse("2026-08-04T12:00:00.000Z");
  const notice = sideChatContextNotice("leaf-123", snapshotAt);
  const boundary = sideChatBoundaryMessage("leaf-123", snapshotAt);

  assert.match(notice, /separate assistant instance/);
  assert.match(notice, /purpose is to handle a focused tangent/);
  assert.match(notice, /did not participate/);
  assert.match(notice, /Only user turns after the side-chat boundary are active instructions/);
  assert.match(notice, /main assistant.*never to yourself/);
  assert.match(notice, /leaf leaf-123 at 2026-08-04T12:00:00.000Z/);
  assert.match(notice, /working directory is shared/);
  assert.match(notice, /Treat current file contents as authoritative/);
  assert.match(notice, /Never revert, overwrite, or restore/);
  assert.match(notice, /may inspect and modify files/);
  assert.match(boundary, /Side-local conversation starts after this boundary/);
  assert.match(boundary, /snapshot leaf: leaf-123/i);
});

test("inherited messages carry explicit provenance labels", () => {
  const opening = inheritedMainChatOpening("leaf-123");
  const user = markInheritedMainChatMessage({
    role: "user",
    content: [{ type: "text", text: "Continue the refactor" }],
    timestamp: 1,
  });

  assert.match(opening, /background reference only/);
  assert.equal(user.role, "user");
  assert.equal(typeof user.content, "object");
  assert.match((user.content as Array<{ type: string; text?: string }>)[0]?.text ?? "", /not a current instruction/);
  assert.equal((user.content as Array<{ type: string; text?: string }>)[1]?.text, "Continue the refactor");
});

test("side status stays hidden unless local work is unsent", () => {
  assert.equal(sideStatusLabel(0, 0), undefined);
  assert.equal(sideStatusLabel(3, 0), "side · unsent");
});

test("handoff state becomes dirty only after new local work", () => {
  assert.equal(hasUnhandedWork(3, 3), false);
  assert.equal(hasUnhandedWork(4, 3), true);
  assert.equal(sideStatusLabel(3, 3), undefined);
  assert.equal(sideStatusLabel(4, 3), "side · unsent");
});
