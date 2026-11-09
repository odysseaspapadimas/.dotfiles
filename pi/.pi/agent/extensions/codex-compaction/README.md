# Native OpenAI compaction

Locally maintained fork of `@ogulcancelik/pi-codex-compaction` **0.1.7**, by Can Celik, with native compaction for the public `openai` connection. The upstream MIT license is preserved in `LICENSE`.

Incorporates the source fix for [upstream #57](https://github.com/ogulcancelik/pi-extensions/issues/57), commit [`6e0a44fb6c78850f183ce09e2eb6253e69078062`](https://github.com/ogulcancelik/pi-extensions/commit/6e0a44fb6c78850f183ce09e2eb6253e69078062). On modern Pi, live replay no longer replaces the whole provider input or reconstructs tool declarations: `context_with_system` substitutes one placeholder for checkpointed conversation messages while retaining system messages, Pi serializes the prompt/tools/tail, and `before_provider_request` swaps only that placeholder for the opaque history. Inline `additional_tools`, grammar schemas, removals, and prompt updates stay exactly where Pi put them. Missing, duplicate, or stale placeholders block the request.

The local fork is still necessary: upstream 0.1.7 activates only for `openai-codex`, whereas our default connection is `openai`. Do not replace this directory with the upstream package until that connection is supported and existing native checkpoints can be replayed safely.

Pi discovers this directory through `index.ts`. Do not also enable the npm package: both register the same compaction hooks. Uses the running host's public `pi-ai` API, supporting both standalone binaries and Node installations (tested on Pi 1.4 and 1.5); no separate host dependency is installed here.

## Connections

- **`openai` / `openai-responses`:** uses documented server-side inline compaction through `/responses`. ChatGPT subscription credentials currently reject the standalone `/responses/compact` operation. A dedicated request uses the minimum permitted inline threshold (1000), low reasoning, and disabled tool invocation. The completed checkpoint emitted **before generation** is replayed unchanged. Any generated continuation and later checkpoints from this maintenance request are discarded: they are not a real user turn and must not invent task progress in session history. Temporary instructions such as “reply OK” are never added, since they can contaminate the opaque checkpoint. Usage includes the entire maintenance request.
- **`openai-codex` / `openai-codex-responses`:** preserves the upstream Codex trigger, feature header, and approximately 64k recent user-text retention.

Pi still owns compaction timing, continuation, cancellation, and usage accounting. Configure `compaction` in Pi settings. To build maintenance requests (not ordinary live replay), public Responses serialization uses the running host's `openAIResponsesApi().stream()` with `onPayload`, including prompt/tool updates, grammar tools, encrypted reasoning, images, and matched call results. This serialization-only call uses a dummy key, stops in `onPayload` before sending, and supplies a rejecting fetch as a network guard; it never authenticates or generates a response. No internal helper files are required on disk. Repeated maintenance requests still seed callable schemas from the checkpoint-time transcript snapshot before later tool deltas; older checkpoints without a saved system snapshot use their raw prefix. This bootstrap remains necessary because maintenance does not pass through Pi's normal request lifecycle. Ordinary replay instead preserves Pi's serialized prompt and tool state unchanged, using the upstream fix above.

The public gateway may omit checkpoint items from the terminal response's `output`; the extension reads the ordered completed item stream instead. An output-limit stop is accepted only after the pre-generation checkpoint completed, since only the discarded continuation was truncated.

Native checkpoints retain the existing `openai-codex-native-compaction` details kind for old sessions and side-chat compatibility. They remain model/provider/API-specific. An incompatible switch, malformed checkpoint, or conflicting context edit blocks continuation rather than silently losing checkpointed history. Failed remote compaction cancels without replacing history or falling back to a text summary.

The upstream handling of optional `/compact` instructions is unchanged; this fork does not add support for them. `keepRecentTokens` controls Pi's local retained projection, not the provider-native checkpoint contents.

## Validation

From the extensions directory, run the CLI regression against the actual `pi` command (or set `PI_TEST_CLI` to a launcher path). This also tests standalone hosts without `node_modules`:

```bash
node --test tests/codex-compaction-cli.test.mjs
```

The SDK tests and typecheck need an unpacked Node Pi package. Set `PI_TEST_HOST` to that package's directory when the active launcher is a standalone binary, then run:

```bash
node --import ./tests/pi-host.mjs --test tests/codex-compaction.test.ts tests/side-native-checkpoint.test.ts tests/installed-extensions.test.ts
node ./tests/typecheck.mjs
```

The #57 regressions use Pi's actual public OpenAI and Codex serializers, not hand-written top-level `tools` arrays. They cover inline grammar tools, additions/removals, inherited and repeated checkpoints, queued messages with old timestamps, retry stability, and fail-closed replay. All regression tests are offline. Live smoke tests, when run separately, use synthetic conversation data, never an existing session or its history.
