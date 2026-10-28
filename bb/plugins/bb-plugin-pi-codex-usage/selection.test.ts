import { expect, test } from "vitest";
import { isPiOpenAI, usageTarget, resetLabel } from "./selection.ts";
test("gates by actual Pi provider namespace, not model name", () => {
  for (const model of ["openai/gpt-5.4", "openai-codex/gpt-5.4"]) expect(isPiOpenAI({ providerId: "pi", model })).toBe(true);
  for (const model of ["anthropic/claude", "openrouter/openai/gpt-5", "openai-compatible/gpt-5", "gpt-5", ""]) expect(isPiOpenAI({ providerId: "pi", model })).toBe(false);
  expect(isPiOpenAI({ providerId: "codex", model: "openai/gpt-5" })).toBe(false);
  expect(isPiOpenAI(null)).toBe(false);
});
test("resolves existing hosts and environments without guessing a default machine", () => {
  const scope = { kind: "new-thread", projectId: null } as const;
  expect(usageTarget({ kind: "thread", threadId: "t" }, null)).toEqual({ kind: "thread", threadId: "t" });
  expect(usageTarget(scope, { environment: { type: "reuse", environmentId: "e" } })).toEqual({ kind: "environment", environmentId: "e" });
  expect(usageTarget(scope, { environment: { type: "host", hostId: "h", workspace: { type: "personal" } } })).toEqual({ kind: "host", hostId: "h" });
  expect(usageTarget(scope, { environment: { type: "provider", environmentProviderId: "personal", inputs: null, machine: { type: "existing", hostId: "h2" } } })).toEqual({ kind: "host", hostId: "h2" });
  expect(usageTarget(scope, { environment: { type: "project-default" } })).toBe(null);
  expect(usageTarget(scope, null)).toBe(null);
});
test("formats missing, elapsed and future resets", () => {
  expect(resetLabel(null, 0)).toBe("?");
  expect(resetLabel("invalid", 0)).toBe("?");
  expect(resetLabel(new Date(0).toISOString(), 0)).toBe("0m");
  expect(resetLabel(new Date(90000).toISOString(), 0)).toBe("1m");
  expect(resetLabel(new Date((5 * 24 + 10) * 3600000).toISOString(), 0)).toBe("5d10h");
  expect(resetLabel(new Date(3600000).toISOString(), 0)).toBe("1h");
});
