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

The visibility choice lasts for the current Pi runtime; `/reload` resets it to visible. `/diff clear` asks for confirmation, then uses the current files as a new **review** baseline and resets review counters and visible per-turn diff scopes without changing project files. It does **not** remove retained per-turn restoration targets, restoration audit records, automatic safety checkpoints, or named checkpoints.

Create and manage restore points with separate commands:

```text
/checkpoint [label]
/checkpoint promote <safety-id> [name]
/checkpoints
/checkpoints list
/checkpoints storage
/checkpoints delete <name-or-id>
/checkpoints prune
/restore-history [status|prune]
/rollback [name-or-id|last]
/restore [name-or-id|last]
```

`/rollback` and `/restore` are aliases. With no argument they open one newest-first timeline containing retained genuine agent-work turns, named checkpoints, and automatic safety checkpoints. Linked turns lead with the triggering user-message excerpt and concise file stats, with turn/time metadata secondary; legacy turns fall back to `Agent-work turn #N`. Selecting a linked turn asks explicitly between **Undo changes from this response** (the default; restore its pre-state) and **Restore state after this response**, in that order. Named checkpoints remain durable landmarks in this same timeline. `/rollback last` and `/restore last` undo the newest eligible genuine agent-work turn; restoration audit turns are excluded, so repeated use walks backward rather than oscillating.

Every target—including checkpoints—then uses one explicit Pi action menu. It summarizes the target, actual-current-to-target stats, external/unrecorded divergence, excluded scope, and automatic safety-checkpoint/verification/audit behavior, with **Restore now**, **Preview in Hunk**, and **Cancel** in that order. Nothing opens Hunk automatically and there is no separate yes/no confirmation: deliberately selecting **Restore now** is the confirmation boundary. **Preview in Hunk** only writes/opens the patch and never mutates workspace files. Because Pi cannot safely keep a modal menu suspended while focus is in Hunk, the exact pending preview is retained; return to Pi and invoke `/restore`, `/rollback`, or Ctrl+X z to resume the same action menu without regenerating it. Cancel discards that pending preview.

Every restoration is computed from the actual current workspace, not the ledger's last remembered state. External/unrecorded divergence is disclosed and included in the preview and safety checkpoint. A no-op reports that the target already matches and creates neither a checkpoint nor an audit turn. **Restore now** captures an automatic safety checkpoint, restores and verifies the target, appends an auditable restoration turn, and adds a visible TUI-only conversation marker describing the target and divergence. Files changing after preview cause the retained preview to fail stale verification before any checkpoint or mutation; invoke restore again to make a fresh selection/preview.

The restoration scope exactly matches capture: Git-tracked plus non-ignored untracked regular files and symlinks across the repository, including executable mode. Ignored files, submodule contents, directories, and special files are excluded and are not changed. These exclusions are repeated in the confirmation.

`/checkpoints` manages or deletes landmarks and reports storage; its `prune` action deletes automatic safety checkpoints only. `/restore-history status` reports retained automatic turn targets/audits separately from checkpoints. `/restore-history prune` requires confirmation and deletes only those per-turn targets and audit records; its prompt discloses exact counts and explicitly states that diff review scopes plus all named and safety checkpoints are preserved. **Ctrl+X z** opens the same restoration timeline (never an immediate restore) and preserves any editor draft.

The first selection starts `hunk patch <stable-cache-file> --watch` in the selected user-facing pane or tab. Later selections reuse the corresponding target and rewrite the same watched file in place. Hunk 0.17.3 did not reliably observe patch-file rewrites in the practical Herdr PTY test, so the extension restarts only the Hunk command in that pane as a deterministic fallback. Hunk provides its normal sidebar plus split/stack layouts.

Agents should load `hunk-review` and use `hunk session list/get/review/context/navigate/comment ...`. They must not launch interactive Hunk commands from tools; the extension launches the TUI only in the user-facing Herdr pane.

## Storage and retention

Content-addressed, gzip-compressed file blobs and snapshot manifests live under:

```text
~/.cache/pi-changes-ledger/<pi-session-id>/
├── blobs/<sha256>.gz
├── snapshots/<sha256>.json.gz
└── index.json
```

The version-3 index contains only snapshot IDs (plus review-turn, recovery-turn, checkpoint, and stats metadata), never inline file maps. Review turns drive `/diff`; recovery turns independently retain restoration targets and audit records. Snapshot IDs are the SHA-256 of the uncompressed manifest bytes and manifests reference the file blobs they need. Version-1 inline indexes and version-2 snapshot-ID indexes are migrated lazily and atomically when that session is next opened; the original index remains intact if migration cannot be completed. Safe v2 migration initially copies its retained turns into both review and recovery histories.

Checkpoint storage is durable and independent of turn retention:

- **Named checkpoints** have a unique, non-empty name and remain until explicitly deleted. A session cache containing one is pinned against age, count, and global-size pruning; named checkpoints are never silently discarded.
- **Automatic safety checkpoints** are unnamed and retain the newest 10 per session. Creating the eleventh removes the oldest automatic checkpoint, but never a named checkpoint.
- `/checkpoint promote <safety-id> [name]` (or **Promote to named checkpoint** in the picker) converts that same automatic record into a named checkpoint. If the interactive command omits the name, Pi asks for it. The checkpoint ID, snapshot ID, restoration source label/ID, manifest, and blobs remain identical: no snapshot or blob is copied. Promotion removes the record from automatic rolling retention and pins its existing graph as a named root.
- Review baseline/latest, review turns, recovery turns, and all retained checkpoints are manifest GC roots. Their manifests and referenced blobs remain reachable; deletion/automatic rollover removes content only when no other root references it.
- Named checkpoint storage is measured as unique physical manifest/blob bytes. `checkpointStorageReport()` raises its `warning` flag at 250 MiB so commands can warn the user; crossing the threshold does not prune anything.

The ledger management API exposes `createCheckpoint("named", name)`, `createCheckpoint("automatic")`, `promoteCheckpoint(safetyId, name)`, `listCheckpoints()`, `deleteCheckpoint(idOrName)`, `checkpointStorageReport()`, `recoveryHistoryReport()`, and `pruneRecoveryHistory()`. Promotion is zero-copy and preserves identity/provenance.

Restoration uses the two-phase API: `previewRestore(target)` returns an actual-current-to-target `Scope` plus external divergence for Hunk review, then `rollback(preview, { confirmed: true }, turnIndex)` performs the restore (the method name remains for compatibility). `previewRollback(checkpoint)` is the checkpoint compatibility wrapper. The explicit confirmation object is required at the API boundary, and stale previews are rejected. Immediately before mutation, restoration records an automatic safety checkpoint labeled with the human-readable restoration source (while retaining its technical target/checkpoint IDs); it restores regular files, symlinks, and executable modes, deletes tracked-scope paths absent from the target, verifies the result, and appends a restoration-kind audit turn without rewriting prior history.

Only small cache pointers and stats are appended as Pi custom entries; raw patches do not enter model context or session history. The selected patch is generated on demand at `selected.patch`.

Safety limits are checked from Git metadata before any content is read:

- Git worktrees only
- at most 5,000 candidate files
- at most 100 MiB total candidate bytes
- at most 20 MiB per file
- 2-second timeout for candidate enumeration

Exceeding a limit disables the ledger without storing partial blobs.

Retention defaults:

- last 100 completed Pi review turns and last 100 recovery turns per session (independently bounded)
- inactive session caches for 14 days
- at most 20 cache sessions
- 1 GiB global soft cap, pruning oldest inactive sessions first

Garbage collection follows all roots described above and removes unreferenced manifests and blobs after turn completion, checkpoint changes, `/diff clear`, or explicit recovery-history pruning. The active baseline/latest snapshots and named checkpoints are retained even if they exceed a soft cap. Consequently, pinned data may make the global cache exceed 1 GiB; it requires explicit named-checkpoint deletion.

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
- Historical data is cache-backed. Manual cache deletion, a missing/corrupt snapshot manifest, or retention pruning makes those old turn scopes unavailable; no raw content is embedded in Pi's JSONL session. Named retention protects against ledger pruning, not manual cache deletion.
- Version-1 migration occurs only when a matching session is opened. It needs the existing inline index and blobs; it does not recreate already-missing blob content. Once rewritten as version 2, older extension versions cannot read that index.
- Hunk is focused after opening. Enter reuses a split in Pi's tab; Alt+Enter reuses the dedicated Hunk tab.
- Because of the Hunk 0.17.3 patch-watch fallback above, changing `/diff` scope starts a fresh Hunk live-session id and clears live-only comments from the prior scope.
