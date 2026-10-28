---
name: feature-session
description: Open or resume an independent persistent BB feature thread, optionally in an isolated worktree. Use when the user requests a separate feature session or isolated feature work; not for ordinary coding in the current thread or discussion.
---

# Persistent feature sessions

Read the bb-cli skill and `bb guide threads` / `bb guide environments` before
controlling BB. Use BB threads and environments, not Herdr panes or Pi IPC.

## Ownership and scope

- A feature thread is an independent owner the user can work with directly.
  Opening one, even with a task to forward, is a handoff rather than permission
  to supervise it. Finish after setup, startup verification, optional task
  submission, and reporting where it is. Do not monitor work, review its
  findings, or send follow-ups unless requested.
- Carry over the actual goal: investigation, exploration, implementation, or
  shipping. Do not turn a complete feature into an arbitrary first slice.
  Shipping requests include relevant validation and a reviewable PR when asked.
- Do not set lifecycle ownership for an independent feature owner: archiving a
  hub must not archive the feature. Sidebar parentage is a separate choice.
- Preserve the user's provider, model, reasoning, and service-tier preferences.
  Fresh feature sessions inherit the launching session's provider and model;
  use xhigh when supported unless the user specified otherwise. Explicitly
  pass these choices after checking the target machine's model catalog.
  Report the supported reasoning level actually applied. Never silently select
  a cheaper model. Resuming preserves the existing session's choices.

## Inspect before creating

1. Run `bb status --json`. Resolve the requested project and machine using list
   commands. Inspect its instructions and any worktree setup requirements.
2. List candidate threads and environments for that project and machine.
   Inspect actual checkout, branch, task, and owner; labels alone are not
   identity. Use `git worktree list --porcelain` on the owning machine when
   needed. Reuse existing worktrees wherever they live.
3. Reopen an existing owner without adding a prompt when asked merely to open
   or resume it. Do not interrupt a busy owner, replay its original task, fork
   it, or create another owner to satisfy a layout convention. Forward an
   explicitly requested follow-up once. Resolve ambiguous ownership first.

## Create only what is missing

- Use an existing environment for an existing checkout. For requested isolation,
  use BB's managed Worktree provider or attach the already-existing worktree;
  do not silently fall back to the main checkout.
- Resolve the remote default branch for a new feature and use it as the base;
  preserve an existing feature branch's tip. Never reset a branch or switch
  the main checkout. Inspect provider inputs and current CLI help before
  constructing commands; do not invent unsupported flags or environment IDs.
- BB worktree paths are provider-owned; do not impose Herdr's path convention
  or move existing checkouts. Read the project's setup hook and inclusion rules.
  Do not copy ignored credentials, share databases, run migrations, or start
  services merely because a session is being opened.
- A new thread needs an initial prompt. If the user requested only an empty
  session, give it a setup-only prompt: identify its checkout and instructions,
  then wait without changing files or starting feature work. Explain this
  setup turn in the handoff. Do not pretend a feature was requested.
- Supply substantive tasks through `--prompt-file`, with the outcome,
  checkout/branch, relevant instructions, and existing artifacts. Keep the
  thread visible and independent. Preserve the user's current focus unless
  they asked to switch to it.
- After a partial failure, re-read threads/environments before retrying. Add
  only missing pieces; delivery acceptance is not task completion.

## Verify startup and hand off

Inspect identity, environment readiness, actual model/reasoning choices, and
startup errors only. This check is not a review of the feature's work. Report
the thread as `@thread:<actual-id>`, checkout, branch, environment ID, actual
execution choices, and whether setup is ready or needs input. Stop there unless
the user requested supervision.

Never archive the last live feature thread as routine cleanup: BB may retire
and remove its managed worktree after its grace period. Preserve checkouts and
history; cleanup and lifecycle changes need a separate user request.
