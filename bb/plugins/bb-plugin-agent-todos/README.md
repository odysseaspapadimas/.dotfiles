# Agent Todos

Displays Pi's existing rpiv-todo list in a compact, collapsible banner **above
the composer**, not in a right-hand panel. Read-only: no duplicate task store or
tool. Hidden without tasks. Collapsed summary shows activeForm/current task
and completed/total. Expanded view shows pending, active, completed tasks.
Task state survives reloads because Pi owns persistence.

## Data source

Server resolves the thread's current provider identity and environment through
the public BB SDK, then calls this plugin's host entry on that machine.
The host reads only that Pi session's task snapshots, follows persisted branch
parents, and returns task fields only—not conversation text. Custom
rpiv-todo-state snapshots take priority over older toolResult details, matching
the installed extension's replay (including nested/codemode calls and clear).
Deleted tasks are excluded.

Supports the installed Pi bridge JSONL v3 and rpiv-todo snapshot format.
Session location defaults to ~/.bb/pi-bridge-sessions; a host worker environment
BB_PI_BRIDGE_SESSION_DIR overrides it. If the provider is configured with a
different directory, the host worker must receive the same override.
A branch navigation with no subsequent persisted entry cannot be observed until
Pi writes its new leaf. BB/native or other providers' task lists are not included.

Polls every 2 seconds while running and every 10 seconds when idle, and on window
focus/tab visibility. Hidden tabs do not poll. Errors preserve the last known
tasks and visibly mark them stale. Server requests are coalesced per thread.
Host caches parsed results by file stamp (16 sessions max); file size capped at
64 MiB and snapshot capped at 1000 tasks. Oversize/unsupported state is reported,
not silently truncated. No Pi extension restart or provider modification needed.

## Development

npm run typecheck
npm test
bb plugin build
bb plugin install . --yes
