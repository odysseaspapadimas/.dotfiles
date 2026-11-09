# Native OpenAI compaction

Locally maintained fork of `@ogulcancelik/pi-codex-compaction` **0.1.7**, by Can Celik, with native compaction for the public `openai` connection. The upstream MIT license is preserved in `LICENSE`.

Incorporates the source fix for [upstream #57](https://github.com/ogulcancelik/pi-extensions/issues/57), commit [`6e0a44fb6c78850f183ce09e2eb6253e69078062`](https://github.com/ogulcancelik/pi-extensions/commit/6e0a44fb6c78850f183ce09e2eb6253e69078062), plus a public-OpenAI replay-order fix. On modern Pi, `context_with_system` substitutes one placeholder for checkpointed conversation messages while retaining system messages. Pi serializes its own prompt/tools/tail. `before_provider_request` then splices in the opaque history without reconstructing tool declarations. Codex keeps upstream's in-place splice; public OpenAI replays the serialized system prefix **after** the checkpoint, because declarations before it are ineffective on the tested public connection. Prefix items and tail items retain their contents and relative order, including grammar schemas, removals, and prompt updates. Missing, duplicate, or stale placeholders, or an unsafe non-system prefix, block the request.

The local fork is still necessary: upstream 0.1.7 activates only for `openai-codex`, whereas our default connection is `openai`. Do not replace this directory with the upstream package until that connection is supported and existing native checkpoints can be replayed safely.

Pi discovers this directory through `index.ts`. Do not also enable the npm package: both register the same compaction hooks. Uses the running host's public `pi-ai` API, supporting both standalone binaries and Node installations (tested on Pi 1.4 and 1.5); no separate host dependency is installed here.

## Connections

- **`openai` / `openai-responses`:** uses documented server-side inline compaction through `/responses`. ChatGPT subscription credentials currently reject the standalone `/responses/compact` operation. A dedicated request uses the minimum permitted inline threshold (1000), low reasoning, and disabled tool invocation. The completed checkpoint emitted **before generation** is replayed unchanged. Any generated continuation and later checkpoints from this maintenance request are discarded: they are not a real user turn and must not invent task progress in session history. Temporary instructions such as “reply OK” are never added, since they can contaminate the opaque checkpoint. Usage includes the entire maintenance request.
- **`openai-codex` / `openai-codex-responses`:** preserves the upstream Codex trigger, feature header, and approximately 64k recent user-text retention.

Pi still owns compaction timing, continuation, cancellation, and usage accounting. Configure `compaction` in Pi settings. To build maintenance requests (not ordinary live replay), public Responses serialization uses the running host's `openAIResponsesApi().stream()` with `onPayload`, including prompt/tool updates, grammar tools, encrypted reasoning, images, and matched call results. This serialization-only call uses a dummy key, stops in `onPayload` before sending, and supplies a rejecting fetch as a network guard; it never authenticates or generates a response. No internal helper files are required on disk. Repeated maintenance requests still seed callable schemas from the checkpoint-time transcript snapshot before later tool deltas; older checkpoints without a saved system snapshot use their raw prefix. This bootstrap remains necessary because maintenance does not pass through Pi's normal request lifecycle. Ordinary replay instead preserves Pi's serialized prompt and tool definitions without reconstruction, using the connection-specific placement above.

The public gateway may omit checkpoint items from the terminal response's `output`; the extension reads the ordered completed item stream instead. An output-limit stop is accepted only after the pre-generation checkpoint completed, since only the discarded continuation was truncated.

Native checkpoints retain the existing `openai-codex-native-compaction` details kind for old sessions and side-chat compatibility. They remain model/provider/API-specific. An incompatible switch, malformed checkpoint, or conflicting context edit blocks continuation rather than silently losing checkpointed history. Failed remote compaction cancels without replacing history or falling back to a text summary.

The upstream handling of optional `/compact` instructions is unchanged; this fork does not add support for them. `keepRecentTokens` controls Pi's local retained projection, not the provider-native checkpoint contents.

## Public replay ordering: 2026-11-09 correction

The initial adaptation of upstream's Codex-only fix preserved `additional_tools` **before** the public inline checkpoint. That was syntactically present but not callable: on the tested `openai/gpt-6.1-sol` connection, the checkpoint resets effective tool state. This can affect a freshly started runtime, not just an old runtime that missed `/reload`. The previous whole-input public workaround happened to seed tools after the checkpoint; maintenance requests still use that correct order.

A separately authorized, bounded synthetic provider A/B used one newly generated fictional checkpoint, one harmless grammar marker tool, and the same prompt/model for both placements. Six requests total: checkpoint generation, no-checkpoint control, and two trials of each placement. No returned tool call was executed; no user transcript or existing checkpoint was sent.

| Request input order | Observed provider behavior |
| --- | --- |
| `additional_tools`, prompt, user (control) | Produced the marker tool call |
| `additional_tools`, prompt, **checkpoint**, user | `NO_TOOL_AVAILABLE`, zero tool calls, both trials |
| **checkpoint**, `additional_tools`, prompt, user | Produced the marker tool call, both trials |

All trial payloads contained the same one tool schema and had no API errors. Presence alone was therefore not a sufficient regression assertion. Public live replay now puts the opaque history first, followed by Pi's serialized system prefix and unchanged tail. The guard permits only system/tool-declaration/configuration prefix items; it refuses to reorder conversation or tool-call history. Codex placement and checkpoint storage/version are unchanged. These provider observations apply to the tested connection, not an untested claim about every Responses backend.

## Activation and recovery

Updating the source does not update a loaded runtime. After the owner is idle and its session is backed up, use the target runtime's actual `/reload` command, or stop and resume the **same** session to create a fresh runtime. Do not send `/reload` as an ordinary model prompt and assume it ran.

Existing compatible native checkpoints do not need migration, rewinding, or regeneration for this fix: their snapshots retain the schemas, and the correction is in outgoing replay ordering. Do not disable native compaction or discard the checkpoint as a recovery shortcut. Verify one harmless **actual tool call** after reload before resuming normal work. If inspecting request metadata, public replay must show the checkpoint before callable declarations; log only item kinds/schema counts, never prompt contents, credentials, or encrypted checkpoint bytes. Tool names in prose or schemas existing somewhere in `input` do not prove callability.

## Validation

From the extensions directory, run the CLI regression against the actual `pi` command (or set `PI_TEST_CLI` to a launcher path). This also tests standalone hosts without `node_modules`:

```bash
node --test tests/codex-compaction-cli.test.mjs
```

The SDK tests and typecheck need an unpacked Node Pi package. Set `PI_TEST_HOST` to that package's directory when the active launcher is a standalone binary, then run:

```bash
node --import ./tests/pi-host.mjs --test tests/codex-compaction.test.ts tests/codex-compaction-lifecycle.test.ts tests/side-native-checkpoint.test.ts tests/installed-extensions.test.ts
node ./tests/typecheck.mjs
```

The #57 regressions use Pi's actual public OpenAI and Codex serializers, not hand-written top-level `tools` arrays. They cover inline grammar tools, additions/removals, inherited and repeated checkpoints, queued messages with old timestamps, retry stability, and fail-closed replay. Public regressions additionally require declarations **after** the checkpoint. The SDK lifecycle test exercises real prompt/compaction handling with synthetic SSE, late tool registration/removal, prompt-only system patches, repeated maintenance, JSON-roundtripped resume, and reload. The CLI probe verifies public ordering in the actual launcher, including standalone hosts.

All checked-in regression tests are offline. Live A/B findings above were a separately authorized one-time synthetic experiment, not part of the test suite. Any future live smoke test requires explicit authorization and fictional conversation data, never an existing session or its history.
