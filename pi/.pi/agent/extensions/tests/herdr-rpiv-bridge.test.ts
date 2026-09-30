import assert from "node:assert/strict";
import { test } from "node:test";
import bridge from "../herdr-rpiv-bridge.ts";

test("RPIV question wait and completion map to Herdr blocked state", () => {
  let listener: ((data: { active?: boolean } | undefined) => void) | undefined;
  const emitted: Array<{ active: boolean; label: string }> = [];
  bridge({
    events: {
      on: (name: string, callback: typeof listener) => {
        assert.equal(name, "rpiv:ask-user:blocked");
        listener = callback;
      },
      emit: (name: string, data: { active: boolean; label: string }) => {
        assert.equal(name, "herdr:blocked");
        emitted.push(data);
      },
    },
  } as Parameters<typeof bridge>[0]);

  assert.ok(listener);
  listener({ active: true });
  listener({ active: false });
  assert.deepEqual(emitted, [
    { active: true, label: "Needs input" },
    { active: false, label: "Needs input" },
  ]);
});
