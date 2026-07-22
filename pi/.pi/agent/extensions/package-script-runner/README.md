# Project script runner

Search and run `package.json` and `composer.json` scripts from Pi without replacing the prompt draft.

## Usage

- `Ctrl+X x` or `/scripts` opens a centered searchable Pi picker.
- The picker starts in browse mode. Press **s** to enter search mode, type to filter, then press **Esc** or **Ctrl+G** to return to browsing without closing the picker.
- Use **j/k** or Up/Down in browse mode; use Up/Down while searching.
- Press **o** to toggle between running-services-first and normal manifest order. Running service slots are marked `● running`.
- The picker displays the script body and exact shell command before launch.
- **Enter** starts or focuses a repository/script slot in the shared **Project services** Herdr tab.
- **Alt+Enter** uses one reusable focused split beside Pi for short-lived tests, builds, migrations, and generators.
- **Esc** cancels without running anything.

When a running service is highlighted, use **f** to focus it, **r** to restart it, or **x** to stop it; **Enter** also focuses it. No second menu is required. Use **q** or Esc in browse mode to cancel. Different services run concurrently in separate panes. Finished service panes are recycled for newly selected services, and excess idle panes are pruned when the picker opens; active panes are never recycled, closed, or stopped automatically.

## Discovery

Discovery only reads directory metadata, `package.json`, `composer.json`, `.git`, and lockfiles. It never invokes Git, Composer, a JavaScript package manager, or a project script.

- **Inside a Git worktree:** the nearest matching manifest from Pi's cwd up to that worktree boundary is used.
- **At a non-Git workspace root:** manifests at cwd plus manifests from every immediate child Git worktree are aggregated into one picker.
- Discovery is deliberately bounded: it does not recursively crawl grandchildren or arbitrary directories.

JavaScript scripts must be string-valued entries in `package.json#scripts`. Composer scripts may be strings or arrays of strings in `composer.json#scripts`; unsupported values are ignored. Composer entries are labeled like `backend:composer/serve` when both ecosystems need distinction.

JavaScript package-manager detection checks each directory from the package root up to the Git boundary. At each level the precedence is:

1. `pnpm-lock.yaml` → `pnpm`
2. `yarn.lock` → `yarn`
3. `bun.lock` or `bun.lockb` → `bun`
4. `package-lock.json` → `npm`
5. no recognized lockfile → `npm`

Commands include an explicit project-directory change:

```sh
cd -- '/workspace/frontend' && pnpm run dev
cd -- '/workspace/backend' && composer run-script serve
```

## Process safety and target reuse

The shared services tab is identified by the resolved workspace path, not by the Pi pane that created it. Closing or replacing that Pi tab does not stop or orphan the services: another Pi session opened from the same project inside that Herdr workspace reconnects to them. Closing the **Project services** tab itself closes its panes and stops those services.

The adjacent runner remains local to its Pi pane. Each service pane is keyed by project root plus exact invocation, allowing frontend, backend, app, and worker processes to remain active simultaneously without collisions. Tabs created by the older pane-based version are adopted and relabeled automatically when their scripts are still discoverable.

New targets wait for the interactive shell and prompt hooks to become stably idle. Short-lived initialization commands such as `stty` are not mistaken for user processes.

Before any approved interrupt, the process identity is checked again. If it changed, or if it does not stop within four seconds, nothing new is launched. Active service panes are never closed or repurposed automatically.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```
