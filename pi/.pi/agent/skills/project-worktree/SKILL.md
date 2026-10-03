---
name: project-worktree
description: Create or resume a Herdr worktree workspace with one independent persistent Pi session for a feature in a single-repository project. Use for requested isolated or parallel feature work, not discussion-only requests or ordinary new chats.
---

# Project worktree sessions

Read the Herdr skill before controlling Herdr. This skill is for single-repository projects; use a project-specific skill for multi-repo projects.

## Session role and Pi defaults

- Default to an independent, persistent feature session the user can work with directly—not a temporary worker reporting to the hub. A request to open/start a session, even with a task to forward, is a handoff, not a request for supervision.
- The hub's default job ends after setup, startup verification, optional task submission, and reporting where the session is. Do not wait for findings, monitor progress, review diffs, rerun checks, or send supervisory follow-ups unless the user explicitly requests that role. Monitoring/supervision does not itself request independent review or verification. This handoff flow, not the generic Herdr background-worker wait recipe, applies to these persistent sessions.
- The feature owner remains responsible for completing the requested scope, validating its own work, and producing PRs when shipping is requested. Independent does not mean an arbitrary first slice or no tests, commits, PRs, or delegation.
- Fresh hub and feature Pi sessions default to `xhigh`. Use the user's requested provider/model, otherwise the launching Pi's `PI_PROVIDER`/`PI_MODEL` (or the saved Pi defaults if unavailable). Launch explicitly with `herdr agent start <unique-name> --kind pi --pane <pane-id> -- --provider <provider> --model <model> --thinking xhigh`; never choose a cheaper model or lower thinking merely because this is another session. An explicit user preference overrides these defaults. If the selected model cannot support xhigh, report the supported level actually applied instead of claiming xhigh.
- Resuming preserves that session's provider/model/thinking unless the user asks to change them; do not add the fresh-session flags to a recovery launch. Verify startup identity/cwd/readiness via Herdr and model/thinking from Pi's startup display or native session metadata before forwarding a task; `agent get` alone does not expose thinking. Report the actual launch settings. Inspect only startup/identity/error evidence for this check, not the session's work findings.

## Convention

- Keep one canonical root Herdr workspace for the project's main Git checkout.
- Give each feature its own Git worktree and Herdr workspace, with one Pi session in that workspace. Do not create shell tabs by default.
- Place new checkouts at `<parent-of-main-checkout>/.worktrees/<main-checkout-name>/<feature>`. For example, a main checkout at `~/dev/example` uses `~/dev/.worktrees/example/<feature>`.
- Make `<feature>` one safe, readable path component (not `.` or `..`); flatten slashes in branch names and check for collisions before using the path. Validate branch names with `git check-ref-format --branch`. Base new branches on the repository's remote default branch. Do not switch or reset the main checkout.
- Existing worktrees may be elsewhere: resume them where they are instead of moving or duplicating them.
- The request determines intent: shipping, investigation, or exploration. Opening an empty workspace does not itself require a PR; a request to implement a feature calls for the complete feature, not an arbitrary first slice.

## Start or resume

1. Verify `HERDR_ENV=1` and inspect the installed Herdr CLI. Identify the repository's main checkout even when the current directory is a linked worktree. Inspect `git worktree list --porcelain`, local/remote branch refs, `herdr workspace list`, and `herdr agent list`; inspect candidate panes before creating anything. Match repository identity, actual checkout, branch, and task—not just a label or flattened branch name.
2. Find the canonical root workspace associated with the main checkout and reuse its hub Pi. If none exists, use `herdr worktree open --cwd <main-checkout> --path <main-checkout> --no-focus` to open the primary checkout with explicit Git provenance. Inspect the returned workspace/agents before starting Pi; it may have reused an existing workspace. Label a newly created root for the project and start interactive Pi in its available returned pane using the launch defaults above. If several are plausible roots or the returned workspace's ownership is unclear, ask rather than guessing or repurposing it. Do not replace an existing hub Pi merely because it is busy or follows an older layout.
3. Resolve the reuse/recovery cases below first. If the requested checkout already has a workspace or live owner, reuse them, including an older feature pane inside the root workspace; do not move it or create a duplicate to enforce the new convention. If only the checkout exists, open it using `herdr worktree open --workspace <root-id> --path <checkout> --no-focus`.
4. If no checkout exists, choose an unused convention path and a meaningful branch. For a new branch, resolve the remote default ref (for example, `origin/HEAD` → `origin/main`), fetch when needed to obtain a current base, and use `herdr worktree create --workspace <root-id> --branch <branch> --base <remote-default-ref> --path <convention-path> --label <feature> --no-focus`. If the intended local branch already exists, Herdr checks it out: use the same command without `--base`, preserving its tip. For a remote-only feature branch, use that remote feature ref as `--base` instead of the default branch. If the intended branch/base cannot be determined, ask; never silently substitute `HEAD` or reset a branch.
5. Reuse the live Pi owner, or recover its stopped session as described below. Start a fresh interactive Pi when there is no known resumable owner/session for this work (or the user explicitly requested a fresh session), using the explicit launch defaults above. Check that the pane's shell owns the foreground and its actual cwd is the checkout; never start over a server, editor, or agent. Read workspace/pane IDs from responses and verify Pi's startup. No shell tabs are needed by default. If the user requested work to start there, submit it with `herdr agent prompt` as an independent persistent feature session; if they asked only to open/resume a session, leave Pi at its prompt. Carry over the user's actual goal and outcome, plus the checkout/branch and relevant project instructions. Do not invent a "first implementation" limit or blanket bans on committing, PRs, or delegation. If asked to ship, the feature owner works toward a reviewable PR; if asked to explore or investigate, do not manufacture one.
6. Report the workspace/pane/session IDs, checkout, branch, actual provider/model/thinking, and whether Pi is waiting or working, then hand control back. Startup or task submission is not task completion; do not describe the work as done or start supervising it merely because a task was forwarded. Only explicitly requested supervision/review extends the hub's role beyond the handoff.

Use Herdr for live worktree sessions: start and prompt in their workspace; inspect progress and wait only when the user requests that role. `pi_sessions` remains useful for past-session recall, transcript review, or recovery when a session is no longer live in Herdr; do not use `pi_sessions.create` as a required worktree setup step. Do not duplicate a checkout, workspace, or Pi session on reruns. Do not close workspaces or remove worktrees as part of setup. Preserve the user's focus unless they asked to switch.

## Reuse and recovery

| Observed state | Action |
|---|---|
| Checkout, workspace, and live Pi exist | Reuse the owner. Opening it again does not resubmit the task. If there are several possible owners, resolve ownership before starting or prompting another. |
| Checkout exists, workspace/agent is absent | Open only the missing workspace; recover the known session before considering a fresh Pi. |
| Branch exists, checkout is absent | Reuse its existing tip at an unused path; do not recreate/reset the branch. |
| Branch is already checked out elsewhere | Reuse that checkout at its existing path. If it is the main checkout and isolation is requested, ask how to proceed without switching it or forcing a duplicate. |
| Target path belongs to another checkout/task, or a matching workspace has a missing/prunable checkout | Stop and explain the conflict. Do not overwrite, prune, repair, or invent a replacement checkout silently. For a genuinely new feature, choose a distinct unused path. |
| Setup/start failed or timed out | Re-read worktrees, workspaces, panes, and agents before retrying; the operation may have succeeded partially or another caller may have completed it. Add only what is missing. |

For live-owner startup/reuse checks, use `herdr agent get` and pane process metadata: `working` means do not interrupt or re-prompt merely for setup; `blocked` means report that input is needed, inspecting the request only when asked to continue/help; `unknown` means inspect the foreground process rather than assuming Pi has stopped. Read only relevant startup/error/identity output when needed to resolve setup, not work findings for an unrequested review. An idle owner can receive an explicitly requested follow-up, but a setup rerun is not permission to replay its original task. Use an available shell pane only; add a Pi pane/tab when none is available, not a spare shell tab.

For a stopped owner, identify its exact session reference from Herdr metadata or historical recall/transcript review and confirm that it is not live elsewhere. Relaunch in an available pane in the owning workspace with `herdr agent start <unique-name> --kind pi --pane <pane-id> -- --session <known-session-path>`. Preserve the session's original launch cwd, including older layouts, and verify the resumed identity; do not guess with `--continue`, fork it, or create a second live copy. If the session/cwd is ambiguous, ask. A request merely to reopen resumes without a new task prompt; explicit continuation work can receive a follow-up reflecting existing progress.

## Project environment

Read the project's `AGENTS.md` and follow any worktree-specific setup when the task needs a running environment. Do not assume that copying ignored env files from the main checkout or sharing its database is safe. Merely opening a workspace does not imply environment setup, migrations, or starting servers.
