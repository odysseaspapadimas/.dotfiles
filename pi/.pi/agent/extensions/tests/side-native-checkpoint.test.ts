import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("native side-chat checkpoints seed only the independent in-memory session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-side-checkpoint-"));
  const source = SessionManager.create(root, root);
  const details = { kind: "openai-codex-native-compaction", version: 1, modelKey: "openai-codex/gpt-6.1-sol", replacementHistory: [{ type: "compaction", encrypted_content: "opaque-test-checkpoint" }] };
  source.appendCustomEntry("openai-codex-native-compaction", details);
  source.appendMessage({ role: "user", content: "Source tail", timestamp: 1 });
  const path = source.getSessionFile()!;
  await writeFile(path, [source.getHeader(), ...source.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  process.env.PI_HERDR_SIDE = "1";
  process.env.PI_HERDR_SIDE_SOURCE = path;
  delete process.env.PI_HERDR_SIDE_SOURCE_LEAF;
  delete process.env.HERDR_ENV;
  const { default: sideChat } = await import("../herdr-side-chat.ts");
  try {
    const sideSession = SessionManager.inMemory(root);
    const handlers = new Map<string, any>();
    const warnings: string[] = [];
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler), registerCommand() {},
      appendEntry: (customType: string, data: unknown) => sideSession.appendCustomEntry(customType, data),
    };
    sideChat(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")({}, { sessionManager: sideSession, ui: { setStatus() {}, notify: (message: string) => warnings.push(message) } });
    assert.equal(warnings.length, 0);
    const promptOptions: { sections: Record<string, string>; forceSystemPrompt?: string } = { sections: { existing: "Keep existing guidance" } };
    assert.equal(handlers.get("before_agent_start")({ systemPromptOptions: promptOptions }), undefined);
    assert.match(promptOptions.sections.side_chat_provenance, /Only user turns after the side-chat boundary/);
    assert.match(promptOptions.sections.side_chat_snapshot, /source session leaf \(unknown\) at /);
    assert.equal(promptOptions.sections.existing, "Keep existing guidance");
    assert.equal(promptOptions.forceSystemPrompt, undefined);
    const branch = sideSession.getBranch();
    assert.equal(branch.length, 2);
    assert.equal(branch[0].type, "custom");
    if (branch[0].type === "custom") assert.deepEqual(branch[0].data, details);
    assert.equal(branch[1].type, "message");
    if (branch[1].type === "message" && branch[1].message.role === "user") assert.equal(branch[1].message.content, "Source tail");
    const before = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));

    // A persisted/main manager must be rejected before even appending a checkpoint.
    const rejectedHandlers = new Map<string, any>();
    let appended = false;
    sideChat({ ...pi, on: (name: string, handler: any) => rejectedHandlers.set(name, handler),
      appendEntry: () => { appended = true; },
    } as unknown as ExtensionAPI);
    await rejectedHandlers.get("session_start")({}, { sessionManager: source, ui: { setStatus() {}, notify: (message: string) => warnings.push(message) } });
    assert.equal(appended, false);
    assert.match(warnings.at(-1)!, /in-memory Pi session manager/);
    const after = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
