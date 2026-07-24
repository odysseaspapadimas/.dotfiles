# Codex Review extension

A small local Pi wrapper around the official `codex review` command. Codex performs a read-only review; Pi can then validate and apply the saved findings.

## Commands

```text
/codex-review                         # staged, unstaged, and untracked changes
/codex-review uncommitted
/codex-review base main
/codex-review base origin/main
/codex-review commit <sha>
/codex-review uncommitted --fix       # review, confirm, then ask Pi to fix
/codex-review-fix                     # fix latest saved review after confirmation
/codex-review-fix --force             # allow a stale review; Pi must revalidate it
/codex-review-clear
```

Use `--yes` (or `-y`) to skip confirmation, primarily for non-interactive mode.

When the current folder is not itself a Git worktree, an uncommitted review recursively discovers repositories below it, skips clean repositories, and reviews every repository with changes. `base` and `commit` reviews still require the current folder to be inside one repository.

## Safety behavior

- Resolves the official `codex` executable from `PATH`, pins its real path for the extension runtime, and rejects a binary located inside the reviewed repository.
- Runs `codex review` only; Codex does not edit the worktree.
- Records HEAD, the resolved target, git status/index metadata, and hashes changed and untracked file contents for each reviewed repository.
- Refuses to apply findings after repository state changes unless `--force` is explicit.
- Treats reviewer output as untrusted evidence and tells Pi to validate every finding.
- Never commits, pushes, merges, resets, or rewrites history.
- `Esc` cancels an active review in Pi's TUI; reviews time out after ten minutes.
- Full reports are stored with mode `0600` under `~/.pi/agent/codex-review-reports/` (or the configured Pi agent directory).

Run `/reload` after editing the extension.
