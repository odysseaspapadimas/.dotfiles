import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUnhandedWork, sideStatusLabel } from "../herdr-side-chat.ts";

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
