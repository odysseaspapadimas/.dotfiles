# Pi changed-files ledger

Standalone Pi extension for per-turn and whole-session file-change review in Hunk. It does not import, emit events to, or share state with the activity profiler.

## Setup

Hunk is a user-facing executable, not an extension runtime dependency. Install the reviewed, pinned release globally in the user prefix:

```bash
npm install -g --prefix "$HOME/.local" hunkdiff@0.17.3
```

`~/.local/bin` must be on `PATH`. Set `PI_CHANGES_HUNK_BIN` if Hunk lives elsewhere. The extension carries the exact `hunk-review` skill from that pinned npm release and contributes it through Pi's `resources_discover` event.

A global install was chosen over `pi install npm:hunkdiff`: Hunk is launched as an ordinary user TUI in Herdr and its `hunk session ...` CLI must be available outside Pi. Pi package installs do not provide a stable user-level executable path. Pinning the global npm command keeps setup reproducible while keeping Hunk and its large prebuilt runtime out of this extension directory.

## Usage

1. Run Pi inside Herdr.
2. Make changes through one or more Pi turns.
3. Run `/diff`.
4. Pick **Current turn**, a previous turn, or **Entire session**.
5. Press **Enter** to open and focus Hunk in a split pane in Pi's tab, or **Alt+Enter** to open and focus it in a dedicated Herdr tab named `Pi changes · <session>`.

Hide or restore the ambient above-editor indicator without disabling review tracking:

```text
/diff hide
/diff show
/diff toggle
/diff clear
```

The visibility choice lasts for the current Pi runtime; `/reload` resets it to visible. `/diff clear` asks for confirmation, then uses the current files as a new baseline and resets both turn history and session totals without changing any project files.

The first selection starts `hunk patch <stable-cache-file> --watch` in the selected user-facing pane or tab. Later selections reuse the corresponding target and rewrite the same watched file in place. Hunk 0.17.3 did not reliably observe patch-file rewrites in the practical Herdr PTY test, so the extension restarts only the Hunk command in that pane as a deterministic fallback. Hunk provides its normal sidebar plus split/stack layouts.

Agents should load `hunk-review` and use `hunk session list/get/review/context/navigate/comment ...`. They must not launch interactive Hunk commands from tools; the extension launches the TUI only in the user-facing Herdr pane.

## Storage and retention

Content-addressed, gzip-compressed before/after blobs and small JSON manifests live under:

```text
~/.cache/pi-changes-ledger/<pi-session-id>/
```

Only small cache pointers and stats are appended as Pi custom entries; raw patches do not enter model context or session history. The selected patch is generated on demand at `selected.patch`.

Safety limits are checked from Git metadata before any content is read:

- Git worktrees only
- at most 5,000 candidate files
- at most 100 MiB total candidate bytes
- at most 20 MiB per file
- 2-second timeout for candidate enumeration

Exceeding a limit disables the ledger without storing partial blobs.

Retention defaults:

- last 100 completed Pi turns per session
- inactive session caches for 14 days
- at most 20 cache sessions
- 1 GiB global soft cap, pruning oldest inactive sessions first

The active baseline/latest snapshots are retained even if they exceed the soft cap.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

## Limitations

- A “turn” is one settled Pi agent run. All model responses, tool calls, automatic retries, and queued continuations before `agent_settled` are grouped into the same review scope.
- **Git worktrees only:** startup first runs bounded `git rev-parse`. If cwd is `$HOME` or any other non-Git directory, the ledger disables immediately, creates no cache, and shows a warning status. Start Pi inside a project such as `/home/odysseas/dotfiles`.
- In Git worktrees, tracked plus non-ignored untracked files across the repository root are captured. Ignored files and submodule contents are not.
- External/user edits made while a Pi turn is active are attributed to that turn. Edits made while Pi is idle appear in the session scope but cannot be reliably attributed to a specific assistant turn.
- Snapshots preserve regular files, symlinks, and executable modes. Directories, special files, and rename identity are not preserved; a rename is displayed as delete/add.
- Git is required both for safe project-root discovery and binary-capable unified patch generation.
- Historical data is cache-backed. Manual cache deletion or retention pruning makes those old turn scopes unavailable; no raw content is embedded in Pi's JSONL session.
- Hunk is focused after opening. Enter reuses a split in Pi's tab; Alt+Enter reuses the dedicated Hunk tab.
- Because of the Hunk 0.17.3 patch-watch fallback above, changing `/diff` scope starts a fresh Hunk live-session id and clears live-only comments from the prior scope.
