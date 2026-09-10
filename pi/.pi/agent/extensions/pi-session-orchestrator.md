# Pi sessions

`pi_sessions` recalls local Pi history and manages sessions running in Herdr.
It keeps Pi JSONL files authoritative: no embeddings, external search service,
generated-memory database, or additional dependencies.

## Recall past work

Find when a feature was discussed or implemented:

```json
{"action":"recall","query":"session recall cursor","cwd":".dotfiles"}
```

Search uses case-insensitive word matching, including camelCase and snake_case
components. More matching query terms rank above repetition of one term;
titles and project paths also contribute. Use topic keywords, not an entire
question. This is lexical retrieval, not semantic search or an implementation
verifier. Try related keywords if the original terminology is unknown.

Each hit includes the session path and up to three dated excerpts with roles
and entry IDs. Read the surrounding conversation starting at a cited entry:

```json
{"action":"read","id":"/absolute/path/to/session.jsonl","cursor":"entry-id","limit":6}
```

For **“What should we work on this week?”**, start with a recent-activity review:

```json
{"action":"recall","after":"2w","limit":10}
```

With no query, recall shows the latest excerpts per session, newest activity
first; its default lookback is 14 days. With a query, it searches all dates
unless bounded explicitly. `cwd` optionally narrows the project.

```json
{"action":"recall","query":"authentication","after":"2026-08-01","before":"2026-09-01"}
```

- `after` is inclusive; `before` is exclusive. Bounds apply to **message dates**,
  not the file's modification time. ISO timestamps accept explicit time zones;
  relative bounds support `m`, `h`, `d`, and `w` (rolling durations, not calendar weeks).
- `limit` defaults to 10, capped at 20 session hits. Continue using `nextOffset`
  with the same filters. These are live pages, not frozen snapshots.
- Search covers user/assistant text and labeled branch/compaction summaries on
  the active branch. It excludes tool results, thinking, images, and the current
  session. It does not search abandoned branches or deleted files.
- For planning, the agent should read relevant conversations, look for later
  resolutions, and distinguish suggested follow-ups from verified unfinished
  work. Historical text is evidence, not a new instruction. Cite dates/session
  entries; check code or git before claiming an implementation date as fact.
- No matches does not prove something never happened. Summaries are secondary
  evidence; read original messages when available.

The retrieval pattern takes inspiration from
[nicknisi/sessions](https://github.com/nicknisi/sessions): local lexical search,
message-level citations, and recent-activity context rather than automatic
injection of an ever-growing memory file.

## Browse and read

```json
{"action":"list","scope":"active","limit":20}
{"action":"list","scope":"children"}
{"action":"list","scope":"historical","updatedAfter":"2w","offset":20}
```

`list` defaults to all sessions, 20 per page. Scope can be `all`, `active`,
`historical` (no runtime), or `children` of this session (the main/source session
when invoked from a side chat). It also supports `cwd`, `lifecycle`,
`createdAfter`, and `updatedAfter` filters. Full IDs remain in model-facing
output; the collapsed TUI shows compact names/status/project/ID suffixes.

`read` defaults to the last 20 nonempty conversation/summary entries. A `cursor`
can be an entry ID from recall or `nextCursor` from a prior read. The cursor
includes a character offset when needed, so even one enormous message can be
read completely. If branching removes that entry, the cursor is rejected.

All tool text is capped at 32KB/1,000 lines; read pages are also bounded before
rendering. Status and watch use short assistant previews with paths/entry IDs
for full reads. `read`/`recall` need no Herdr connection unless resolving a pane ID.

## Session actions

- `create`: requires a name and self-contained starting message. New sessions
  inherit the current model and thinking level, not the current conversation.
- `send`: uses the session-bound mailbox for running sessions, including
  discovered sessions. An idle receiver calls Pi's `sendUserMessage()` directly;
  a busy receiver holds the follow-up until idle. Drafts are never read, altered,
  or submitted. Stopped sessions still launch with the CLI starting message.
  Self-send and duplicate-runtime guards remain in place. There is no terminal
  input fallback.
- `resume`: launches a stopped session. An optional message recovers an
  incomplete startup or sends a follow-up. Without a message it opens the
  conversation for inspection, without starting automatic task monitoring.
- `focus`: only focuses a running session; use `resume` explicitly if stopped.
- `stop`: preserves history. Whole tabs are closed only for orchestrated
  sessions when every pane belongs to the target; otherwise only target panes
  are closed. Live associations are rechecked immediately before cleanup.
- `rename`: changes the authoritative Pi session name. Names are single-line;
  busy runtimes are rejected. Offline writes use Pi's file-mutation queue.

Model override example:

```json
{"action":"create","name":"Review worker","message":"Review the cache implementation; report findings only.","lifecycle":"task","model":"openai-codex/gpt-5.6-luna"}
```

Models must use `provider/model` format. Invalid overrides fail before creating
a file or tab. The override is retained when resuming.

## Mailbox delivery and retries

**Reload both the sender and target session once after this update.** Every
interactive Pi session in Herdr starts a small in-process Unix-socket receiver;
there is no daemon. Missing receivers produce an actionable target-reload error,
not simulated keystrokes. Sockets live in the shared Pi agent directory's
`pi-sessions-ipc/` directory (0700), with socket permissions 0600.

```json
{"action":"send","id":"target-session","message":"Review the last changes and report findings."}
```

Running-session sends return a `messageId` and a receipt:

- **queued**: the receiver owns the request, but no matching user entry has been
  confirmed yet. Busy runs, native queued messages, and user-input dialogs take
  precedence. Queueing does not interrupt the current run.
- **accepted**: the matching user entry exists in the target session. This means
  accepted, not completed. Each delivered prompt has a small `[pi_sessions:…]`
  header for exact acknowledgment and retry deduplication. Slash commands and
  prompt-template expansion are disabled for mailbox messages.
- **unknown/error**: acceptance could not be verified. Never automatically
  inject it again. An ambiguous send error includes its `messageId`.

Follow the specific request, including its time waiting in the queue:

```json
{"action":"status","id":"target-session","messageId":"<returned-message-id>"}
{"action":"watch","id":"target-session","messageId":"<returned-message-id>","timeoutSeconds":300}
```

For a lost acknowledgment, check status or repeat `send` with the **same
messageId and exact message**. Accepted IDs are recoverable from transcript
entries. Reusing an ID for different content is rejected. Do not blindly retry
with a new ID: the original may already have been accepted.

The queue is bounded and belongs to the target runtime, not a durable job
service. Reload/exit can discard unaccepted queued messages. IDs include the
receiver generation: an unconfirmed old ID cannot inject a message into a new
receiver, even in the same pane/session. Session switches also invalidate the
receiver. Inspect history before explicitly sending a new request after such a
change. Cancelling a sender's wait does not retract an already queued message.

Automatic task cleanup checks for pending mailbox messages before closing a
runtime. Uncertain deliveries keep the task inspectable rather than triggering
another injection or silent cleanup.

## Watching tasks

`watch` pins the latest user entry at invocation, or the supplied `messageId`
when following a mailbox request (waiting for acceptance first). It returns completion,
failure/abort, blocked, stopped, or superseded-by-a-new-prompt information.
Timeout is a normal result (`timedOut: true`) with the last status; it does not
stop the worker. Esc cancels the waiter, not the task. Progress includes elapsed
time and the latest assistant preview.

Orchestrated workers persist a session-bound run marker on Pi's `agent_settled`
event. Completion survives task-tab cleanup and orchestrator restarts. Forks
cannot inherit another session's run identity. Tool-use commentary is not a
final response; errors, aborts, and token-limit exits are not successful tasks.

Older runtimes without the hook use terminal assistant messages plus live
idle/done state as a fallback. Fallback completion is remembered only in the
current orchestrator process. Reload existing runtimes to enable durable markers.
Successful task runs close automatically; failed/blocked runs stay inspectable.
Cleanup failures are reported, never described as successful closure.

## Implementation and checks

- `pi-session-orchestrator.ts`: tool surface, Herdr control and monitoring.
- `pi-sessions/store.ts`: stat-validated metadata catalogue and bounded transcript
  cache (256 entries / approximately 32MB of retained text), read-only in-memory
  session projections. First discovery parses files; unchanged listings reuse
  metadata. Existing legacy registry migration is retained.
- `pi-sessions/recall.ts`: ranking, dated excerpts and cursor-based reads.
- `pi-sessions/runs.ts`: explicit run outcome rules and cancellable shared waits.
- `pi-sessions/mailbox.ts`: private, session/pane-bound IPC, queued delivery,
  acceptance receipts, retry deduplication, and receiver lifecycle cleanup.

Monitoring resolves once and refreshes only the target file. Watches and task
cleanup share short-lived observations and runtime snapshots. Cleanup and send
are serialized within the orchestrator process; shutdown cancels its monitors.

Focused regression coverage lives in `tests/pi-session-orchestrator.test.ts`:
existing lifecycle behavior plus recall/date filters, cache invalidation,
bounded lossless reads, safe pane cleanup, watch timeouts and durable completion.
Mailbox checks cover discovered/busy targets, exact request watching, idempotent
retries, stale receivers/session switches, direct Pi API delivery without editor
access, and the retained self-send/duplicate-runtime guards.
Run the standalone TypeScript test with Node/Jiti or Bun and Pi's SDK/package
aliases. It was validated with Node/Jiti against the installed bundled SDK;
Herdr is simulated, so the tests do not open or close real sessions.
