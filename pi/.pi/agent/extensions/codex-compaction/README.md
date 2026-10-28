# Native OpenAI compaction

Locally maintained fork of `@ogulcancelik/pi-codex-compaction` **0.1.6**, by Can Celik. The upstream MIT license is preserved in `LICENSE`.

Pi discovers this directory through `index.ts`. Do not also enable the npm package: both register the same compaction hooks. Requires the Node-based Pi 1.1 host and its own `pi-ai` API helpers; no separate host dependency is installed here.

## Connections

- **`openai` / `openai-responses`:** uses documented server-side inline compaction through `/responses`. ChatGPT subscription credentials currently reject the standalone `/responses/compact` operation. A dedicated request uses the minimum permitted inline threshold (1000), low reasoning, and disabled tool invocation. The completed checkpoint emitted **before generation** is replayed unchanged. Any generated continuation and later checkpoints from this maintenance request are discarded: they are not a real user turn and must not invent task progress in session history. Temporary instructions such as “reply OK” are never added, since they can contaminate the opaque checkpoint. Usage includes the entire maintenance request.
- **`openai-codex` / `openai-codex-responses`:** preserves the upstream Codex trigger, feature header, and approximately 64k recent user-text retention.

Pi still owns compaction timing, continuation, cancellation, and usage accounting. Configure `compaction` in Pi settings. Public Responses serialization uses the running host converter, including prompt/tool updates, grammar tools, encrypted reasoning, images, and matched call results. The current system prompt is restored separately on replay. Callable tool schemas are restored from the checkpoint-time transcript snapshot before later tool deltas: the opaque checkpoint and prompt text alone do not restore Pi 1.4's inline `additional_tools` declarations. Older checkpoints without a saved system snapshot use their raw prefix.

The public gateway may omit checkpoint items from the terminal response's `output`; the extension reads the ordered completed item stream instead. An output-limit stop is accepted only after the pre-generation checkpoint completed, since only the discarded continuation was truncated.

Native checkpoints retain the existing `openai-codex-native-compaction` details kind for old sessions and side-chat compatibility. They remain model/provider/API-specific. An incompatible switch, malformed checkpoint, or conflicting context edit blocks continuation rather than silently losing checkpointed history. Failed remote compaction cancels without replacing history or falling back to a text summary.

The upstream handling of optional `/compact` instructions is unchanged; this fork does not add support for them. `keepRecentTokens` controls Pi's local retained projection, not the provider-native checkpoint contents.

## Validation

From the extensions directory, set `PI_TEST_HOST` to the running Pi package directory if the managed launcher is not resolved automatically, then run:

```bash
node --import ./tests/pi-host.mjs --test tests/codex-compaction.test.ts tests/side-native-checkpoint.test.ts tests/installed-extensions.test.ts
node ./tests/typecheck.mjs
```

Live smoke tests use synthetic conversation data, never an existing session or its history.
