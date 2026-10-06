# Reliable local Pi–Herdr reporting

This replaces Herdr 0.9.3's bundled Pi integration without modifying its managed
`herdr-agent-state.ts` file. Personal `settings.json` excludes that file with
`"-extensions/herdr-agent-state.ts"`; Pi discovers this directory's `index.ts`
automatically. Herdr updates/reinstalling the bundled hook do not overwrite this
local override.

## Why

The bundled hook treats any socket response (including an API error) as successful
delivery, gives up after two transport attempts, and publishes only on lifecycle
changes. Startup/restore failures can consequently leave idle sessions unregistered
or status stale. This was reproduced against an isolated mock Unix socket, not by
restarting any live user session.

## Behavior

- Validates newline-delimited response IDs and rejects API errors, malformed
  responses, premature disconnects, and timeouts.
- Serializes session registration before lifecycle state. Retains the original
  startup/resume/reload reason when retrying registration.
- Verifies the resulting pane's native session and semantic state; a successful
  response to an ignored report is not considered successful synchronization.
- Retries automatically with 0.5–10 second backoff and refreshes from Pi's current
  idle/working status every 15 seconds, including when there are no new prompts.
- Preserves `herdr:blocked` nesting and Herdr's idle/done attention distinction.
- Keeps sequence counters across extension reloads and backwards clock corrections.
  If the old bundled hook has a future-dated sequence, an unsequenced repair is
  attempted only after Herdr confirms the exact same native session and reporter.
  Herdr's process-generation and ownership checks still apply.
- Never reports for RPC/JSON/print sessions. Timers and pending sockets are disposed
  on session shutdown/reload. No agent prompts, transcript contents, or secrets
  are sent to Herdr.

## Activate

New or reboot-restored Pi processes load it automatically. For a Pi process that
was already running at installation time, run `/reload` once when convenient.
Thereafter `/herdr-sync` offers a manual resync without exiting Pi, although
normal recovery is automatic.

To roll back, replace `-extensions/herdr-agent-state.ts` in personal settings with
`-extensions/herdr-reliable/index.ts` and `/reload`.

## Tests

```sh
node --import "$HOME/.pi/agent/extensions/changed-files-ledger/node_modules/tsx/dist/loader.mjs" \
  --test "$HOME/.pi/agent/extensions/tests/herdr-reliable.test.ts"
```

The automated tests use disposable Unix sockets and fake native session references.
The idle → working → blocked → idle protocol was also verified against a separate
real Herdr 0.9.3 headless test server, which was stopped afterward. The tests
cover delayed startup, rejected/unapplied reports, fragmented replies, heartbeat
refresh, server reconnect, queued updates, clock rollback, safe sequence repair,
blocked/settled lifecycle, headless exclusion, and shutdown cleanup. They do not
control any live Herdr pane or prompt any model.
