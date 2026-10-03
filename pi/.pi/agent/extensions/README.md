# Pi extensions

Local extensions are discovered from this directory through the `~/.pi/agent/extensions` symlink. Installed npm extensions are selected in `../settings.json`.

## Prompt integration

The session orchestrator adds worker ownership guidance in the `session_orchestration` prompt section. Side chats use `side_chat_provenance` for stable role/safety guidance and `side_chat_snapshot` for the source leaf/time updated on context refresh. Neither extension replaces the full system prompt; inherited-history labels and conversation boundaries remain unchanged. This preserves Pi’s structured prompt composition and native prompt-delta handling, without guaranteeing provider cache hits.

## Structured session results

`pi_sessions` declares an output schema, so codemode receives an object instead of formatted text. Every successful result includes `action`, bounded readable `output`, and `truncated`, plus action-specific data: `sessions` for list, `hits`/evidence for recall, paged `messages` for read, and session/runtime/delivery/run fields for management and monitoring. Optional fields are omitted when unavailable. `nextOffset` and `nextCursor` preserve pagination; read message slices include their original character `offset`.

```js
const page = await tools.pi_sessions({ action: "list", scope: "active" });
text(page.sessions.map(({ id, name, status }) => ({ id, name, status })));
```

Delivery acceptance is not completion: retain the returned `messageId` and use it with status/watch. Only an `outcome` reports a settled observed run; queued delivery must not inherit the previous run’s outcome. Existing renderer details and readable output remain available, and failures still reject rather than returning apparent success.

## Compatibility checks

Run against the **currently installed Pi**, including its host-provided modules:

```sh
cd ~/.dotfiles/pi/.pi/agent/extensions
npm test
npm run typecheck
```

The test/typecheck tooling uses the existing development dependencies in `changed-files-ledger/node_modules`. If they are missing, run `npm --prefix changed-files-ledger ci` first. Override host discovery with `PI_TEST_HOST=/path/to/pi-coding-agent` if `pi` is not on `PATH`.

The suite covers the ledger, session/mailbox orchestration, quota history, activity tracking, Fast Mode, session-naming cancellation, side-chat native checkpoints, and narrow-terminal UI rendering. It also loads every configured local/npm extension using Pi's real loader and runs SDK lifecycle/command checks. That installed-extension check defaults to `~/.pi/agent`; override with `PI_TEST_AGENT_DIR`.

The installed-extension suite isolates session storage, disables Herdr integration, stubs network requests, and does not prompt a model. It does not verify paid provider calls, real side-pane creation, or every third-party tool interaction.

Validated on Pi **1.0.0**: all 20 configured extensions loaded, fullscreen and regular-mode PTY startup/overlay checks passed, and both configured MCP servers connected (`pi mcp list --json`). Run `/reload` in existing Pi sessions after extension changes.
