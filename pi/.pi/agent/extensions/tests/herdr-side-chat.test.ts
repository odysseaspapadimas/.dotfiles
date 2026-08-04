import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasUnhandedWork,
  sideChatBoundaryMessage,
  sideChatContextNotice,
  sideStatusLabel,
} from "../herdr-side-chat.ts";

test("side-chat context identifies the boundary and shared working directory", () => {
  const snapshotAt = Date.parse("2026-08-04T12:00:00.000Z");
  const notice = sideChatContextNotice("leaf-123", snapshotAt);
  const boundary = sideChatBoundaryMessage("leaf-123", snapshotAt);

  assert.match(notice, /ephemeral side chat/);
  assert.match(notice, /leaf leaf-123 at 2026-08-04T12:00:00.000Z/);
  assert.match(notice, /working directory is shared/);
  assert.match(notice, /Treat current file contents as authoritative/);
  assert.match(notice, /Never revert, overwrite, or restore/);
  assert.match(notice, /may inspect and modify files/);
  assert.match(boundary, /local side-chat conversation starts here/);
  assert.match(boundary, /snapshot leaf: leaf-123/i);
});

test("side status reports current and stale inherited context", () => {
  assert.equal(
    sideStatusLabel(0, 0, 0),
    "side: ephemeral · context current · 0 local",
  );
  assert.equal(
    sideStatusLabel(1, 3, 0),
    "side: ephemeral · context 1 turn behind · 3 local · unhanded",
  );
  assert.equal(
    sideStatusLabel(4, 3, 0),
    "side: ephemeral · context 4 turns behind · 3 local · unhanded",
  );
});

test("handoff state becomes dirty only after new local work", () => {
  assert.equal(hasUnhandedWork(3, 3), false);
  assert.equal(hasUnhandedWork(4, 3), true);
  assert.equal(
    sideStatusLabel(0, 3, 3, "summary"),
    "side: ephemeral · context current · 3 local · summary handed off",
  );
  assert.equal(
    sideStatusLabel(0, 4, 3, "summary"),
    "side: ephemeral · context current · 4 local · unhanded",
  );
});
