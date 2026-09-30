---
name: luca-ticket
description: Start, resume, inspect, or clean up a Luca ticket with one Herdr workspace and separate Git worktrees for the repos it touches. Use for requested parallel ticket work, not discussion-only questions.
---

# Luca ticket workspaces

## Defaults (override from the request or edit here)

- Root: `~/Luca` (multiple independent Git repos, not one repo).
- Worktrees: `~/Luca/.ticket-worktrees/<ticket>/<repo>`.
- Herdr workspace label: `Luca · <ticket>`; one workspace per ticket, even when it touches multiple repos.
- Base: each repo's `origin/main`, unless the task calls for another branch. Fetch when useful; never switch or reset the primary checkout to make room.
- Intent: shipping work → reviewable PR(s) in the changed repos; investigation → findings; exploration → ongoing session if useful, no automatic PR. Do not merge or deploy just because a PR is ready.

Use a ticket ID safe as one path component (for example `LHD-123`); choose repos and branch names from the task. Shell `~` only expands unquoted; use `$HOME/Luca` when quoting a path. Read the generic Herdr skill for control rules and the touched repos' `AGENTS.md` for code conventions.

## Start or resume

1. Check `HERDR_ENV=1`. A question alone isn't a request to create a workspace. For an actual start, infer ticket, repos and intent from the request; ask only when a missing choice changes the work. Look for an existing ticket workspace and worktrees first; resume them instead of duplicating them. Do not disturb other tickets or dirty primary checkouts.
2. For a new code ticket, anchor on one repo: `herdr worktree create --cwd <repo-root> --branch <ticket-branch> --base <base> --path <ticket-dir>/<repo> --label "Luca · <ticket>" --no-focus`. If that checkout already exists but has no workspace, use `herdr worktree open` for it instead. Take the workspace ID from Herdr's response.
3. For each other affected repo, `git -C <repo-root> worktree add -b <ticket-branch> <ticket-dir>/<repo> <base>` (or reuse its existing ticket checkout), then `herdr tab create --workspace <workspace-id> --cwd <checkout> --label <repo> --no-focus`. **Don't use `herdr worktree create` again**: it would make another workspace for the same ticket. If setup is partial, add only what is missing.
4. For a requested research-only workspace without code checkouts, `herdr workspace create --cwd ~/Luca --label "Luca · <ticket>" --no-focus` suffices. Otherwise research can stay in the current workspace.
5. If asked to start agent work, launch a Pi coordinator in the ticket workspace with `herdr agent start ... --kind pi --pane <pane-id>`, then `herdr agent prompt` with the task, checkout paths and intent. A `pi_sessions.create` call **from the Luca home workspace** would put workers there, regardless of cwd; once the coordinator is inside the ticket workspace, it can create its own task or persistent workers there. Supervise with `pi_sessions` and report workspace/session IDs and checkout paths.

Use the installed Herdr CLI for exact syntax; don't guess IDs. Work can continue without creating one agent per repo. For multi-repo features, one owner coordinates the API and PR dependencies.

## Local environment

After creating worktrees, run `luca-ticket setup <ticket> --repos backend,ims` (omit either repo if not needed; supported repos are backend and IMS). Backend setup uses machine-local `~/.config/luca/local.env` (`references/local.env.example` shows keys); it creates **empty** per-ticket MySQL databases and ignored `.env`, while IMS gets an ignored `.env.local`. It preserves user-owned env files rather than overwriting them. For an updated backend checkout run `luca-ticket init <ticket> backend` to migrate and seed its fictional school; rerunning it is safe. `luca-ticket status <ticket>` reports ports/database names without credentials. Run backend tests via `luca-ticket test <ticket> backend -- [artisan-test-flags]` so PHPUnit cannot default to the shared `luca_backend_test`. For dev servers use the `backend_port`/`ims_port` shown by status; e.g. `php artisan serve --host=127.0.0.1 --port=<backend_port>` and `npm run dev -- --host 127.0.0.1 --port <ims_port> --strictPort`. IMS's local API URL override requires the matching `configURL` change in IMS; confirm it is present in the checkout before claiming the UI points at its ticket backend.

## Work and finish

- Install dependencies, develop, run relevant checks, push requested PRs, and fix failures without routine permission prompts. Backend tests/migrations must use the ticket's disposable local/test DB; frontend-only builds need no database check. Local-only env reuse is fine once its targets are understood; don't assume the primary checkout's `.env` is safe or print secrets.
- Status should say what's running, what's done, and what remains; a finished agent is not itself a verified PR. For shipping work, include PRs and the actual tests/CI result; for investigation, give findings; for exploration, retain progress without manufacturing a PR.
- Close or remove a ticket only when asked. At cleanup time check running agents and dirty checkouts; preserve unmerged or uncommitted work. Never force-remove someone else's worktree or treat closing a workspace as deleting its Git branches.
