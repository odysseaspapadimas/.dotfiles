# Shared Herdr desktop profile

The new `herdr-app` is separate from the old `herdr` TUI. Agents and repositories
live primarily on Debina's **default herdr-core session**. Omarchy and Windows
connect to that same core over SSH/Tailscale.

## Open it

Use **Herdr (Debina)** in the application menu, or `herdr-start` in a new terminal.
The stock `herdr-app` executable is deliberately unmodified; invoking it directly
bypasses our sync step. `herdr-w` still opens the **old** TUI as a rollback path.
No old sessions, old config, or old plugins are migrated or stopped automatically.
Debina has the app installed too, but needs a graphical session to display it;
its core works headlessly.

## One source of truth

Edit **`~/.dotfiles/herdr-app/profile/` on Debina**, not the deployed copies on
other machines. Those saved files are authoritative. They are versionable in
Git, but publishing the profile does **not** require committing/pushing or pulling
the whole dotfiles repo: the launchers fetch this one curated profile over SSH.
This intentionally avoids touching unrelated dirty checkouts.

Portable files:

- `keys.json`: original Ctrl+Space prefix plus the new app's direct shortcuts.
- `settings.json`: bundled JetBrains Mono/Geist fonts, font size, sounds, dark mode.
- `themes/odysseas-macchiato.json`: Catppuccin Macchiato palette and old accent colors.
- `layouts/odysseas.json`: personal copy of Herdr 0.1.11's main layout, slightly
  smaller gaps and our small status/navigation mod. Shipped mods remain upstream-owned.
- `mods/odysseas-nav/`: last-pane/cycling/ordering compatibility actions and host/prefix hints.
- `mods/odysseas-ports/`: native development-port controls backed by the existing portd API.

On launch, a small exporter on Debina sends base64 content and SHA-256 hashes.
Clients validate the entire bundle and the path allowlist before writing files.
Changed existing preferences are backed up, and each replacement is atomic.
Transfers use normal OpenSSH authentication and **verified host keys**; nothing
is exposed through HTTP or a public core socket. Treat Debina's profile as trusted
code: Herdr mods are not sandboxed.

This is **one-way sync-on-launch**, not bidirectional/live background sync. Local
settings changes can be used temporarily but get overwritten by the next sync.
With a previously successful profile, a client can open its cached preferences
when Debina is offline; remote terminals remain unavailable until it reconnects.
There is no process migration or automatic failover.

Press **Ctrl+Space → Shift+R** in the `odysseas` or `odysseas-t3` layout to fetch the profile again, like the old reload-config shortcut. It runs the local sync client, not a command on the selected remote terminal. Or update from a shell while a window is already open (most preferences hot-reload):

```sh
# Debina or Omarchy
herdr-profile sync
```

```powershell
# Windows (new terminal after installation)
herdr-start -SyncOnly
```

Linux source configuration is machine-local:
`~/.config/herdr-profile/source.json` selects Debina's local profile directory on
Debina and SSH host `debina` on Omarchy. On Windows, the launcher uses SSH host
`debina` directly. Each client needs its own working SSH keys/config; no private
keys are stored in this repo.

**Never sync** the entire app home, `view.json`, `shared.json`, `layouts/.state/`,
window state, sockets, update caches, or core state directories. Clicked layout
sizes/themes remain screen-local; edit the personal layout/theme for portable
styling instead. Sync does not delete obsolete files or overwrite shipped mods.
Switching to another layout is a local choice; choose `odysseas` or `odysseas-t3`
to get the shared layouts and their compatibility actions back.

## Prefix migration

Press **Ctrl+Space**, release, then the action key. In the `odysseas` and
`odysseas-t3` layouts, our footer mod takes keyboard focus for the second stroke and highlights
**PREFIX · Esc cancels**. There is no popup or tmux process, and no prefix timeout.
The badge clears after an action, Escape, an unbound second stroke, or clicking
elsewhere. Unbound second strokes are consumed, not replayed into the terminal.
Ctrl+Space twice sends literal Ctrl+Space/NUL through the terminal's native input
handler. Stock direct shortcuts remain available and also end prefix mode.

Other layouts retain the original native GPUI multi-stroke bindings, without the
footer indicator. In `keys.json`, `layout:odysseas` and `layout:odysseas-t3`
activate the footer handler;
`mod:odysseas-nav` mirrors each global `ctrl-space …` action as a single second
stroke (`odysseas-nav.key:<action>`, or `key:literal-prefix` for NUL). Keep both
sets aligned when changing a prefix shortcut; `tests/prefix.test.mjs` checks all
of them. The mod handles second strokes synchronously on its focus path, restores
the selected pane's keyboard, and keeps prefix state client-local/in-memory.

| After Ctrl+Space | Action |
|---|---|
| `c`; `n` / `p`; `1`…`9` | New / next / previous / numbered tab |
| `v` / `-` | Split right / down |
| `h` / `j` / `k` / `l` or arrows | Focus adjacent pane |
| `Tab` / `Shift+Tab` | Cycle panes in the current tab |
| `Backspace` | Last pane, including across tabs/spaces; history is screen-local |
| `z`; `x`; `Shift+X` | Zoom pane / close pane / close tab |
| `Shift+T`; `Shift+N`; `Shift+W`; `Shift+D` | Rename tab / new space / rename space / close space |
| `,` / `.`; `<` / `>` | Move tab left/right; move space up/down |
| `[` / `]`; `Alt+1`…`Alt+9` | Previous/next agent; indexed agent (app API order) |
| `b`; `?`; `s`; `:` | Sidebar / key help / settings / command palette |
| `a`; `Shift+A` (T3 only) | Focus list ↔ Spaces + Agents / single-agent view ↔ tabs and terminals |
| `Shift+R` | Fetch/reload the central Debina profile on this client |
| `f` or `e`; `Shift+F` | Focus/open Neovim in this folder; open an editor split |
| `g` | Git repository picker / LazyGit, in a named tab |
| `Ctrl+F` / `Ctrl+G` | Built-in Files / Changes side panel |
| `o` | Native Development ports dialog (no terminal) |
| `Shift+S` | Project scratch in a named tab |
| `Shift+G`; `Shift+L` | Built-in worktree dialog / switch UI layout |
| `q` | Close this client window, **not** its running terminals |

The editor/Git/scratch helpers execute on the **selected space's machine**,
not the client. They are installed on Debina; they need not exist on Windows.
Use a Debina space for those bindings. Development ports instead controls the
client's portd daemon, independently of the selected project (see below). Files is read-only; Neovim is the editor.
Closing a pane/tab still ends its processes and is not equivalent to closing the
app window.

### Deliberately not ported

- Old `project-scripts`, Dispatch board/plugin actions, transfer popup, and
  old plugin equalize/main-grid actions call the old Herdr API. They were not
  silently pointed at old sessions from the new app.
- The old pane-resize mode, pane rename, and scrollback-editor behavior have no
  equivalent public app commands in this release. Drag split borders for resize.
- Native GUI fonts/metrics differ from the TUI. Styling is similar, not pixel-identical.
- Last-pane compatibility requires `odysseas` or `odysseas-t3` (they host the helper).
- This is not an automatic conversion of running old-Herdr workspaces to new-core
  sessions. Existing old work remains accessible with `herdr-w`.

## Layouts and mods

### Herdr T3

The T3 Code-style community layout is installed as **`odysseas-t3`**, alongside
`odysseas`. Switch with `herdr-app do layout.switch --name odysseas-t3`;
`herdr-app do layout.switch --name odysseas` restores the previous layout.
No terminals are replaced by switching layouts.

Source: [JinJieBeWater/herdr-t3](https://github.com/JinJieBeWater/herdr-t3),
commit `bf05b354f5fc1ed80106a0d3fc7e02f0801d90b6`. Its seven mods are copied as
`mods/odysseas-t3-*` to fit our portable profile, with asset/self-references renamed.
The upstream license is preserved in `mods/odysseas-t3-chrome/LICENSE`.
Our prefix/status footer is visible, and the Files/Changes panel is retained for
the existing prefix shortcuts. The current fonts/theme are unchanged. The layout's
own Cmd+Shift+B/A/S bindings are scoped to this layout; no existing bindings are
overwritten. Its buttons switch sidebar mode and agent view on all platforms. **Ctrl+Space → a**
switches Focus ↔ Spaces + Agents; **Ctrl+Space → Shift+A** switches the work
area between one agent and normal tabs/terminals. **Ctrl+Space → b** still
only hides/shows the sidebar.
Optional extras (pulls.review and the preview theme/fonts) are not installed.
Like other community layouts, these copies do not update automatically.

Agent rows have a dedicated **project › branch/worktree** line, including priority,
grouped and pinned rows. Focus cards show the canonical project and machine above
the session title, with the branch/worktree below; settled agents retain that
context too. Project identity is read from Git's common directory on the agent's
own machine, so renamed spaces and worktrees outside a conventional directory
still work. The lookup uses the agent's actual pane/terminal folder, not the first
terminal in its space. Results are cached in memory with no new polling timer;
offline/non-Git folders use a folder fallback. It never changes Git or agent state.

### Neon City

**`odysseas-city`** is a separate, switchable native layout. Projects become
**districts**, Git checkouts/worktrees become **buildings**, and agents are
clickable **office windows**. Canonical Git paths keep same-named repositories
separate; each district also names its machine. Terminal-only spaces stay visible.

- Click a building to enter its checkout; click a lit window to focus that agent.
- Right-click a window for a live terminal peek, or a building for its directory.
- Cyan pulses mean working, orange flashes mean needs you, green means done,
  purple means idle, and dark windows are settled. Native GPU animations stop
  when inactive; there is no animation polling timer.
- **Overview / Work** (or **Ctrl+Space → a**) resize the skyline above the real
  tabs and terminals. **Ctrl+Space → b** hides/shows it. Prefix status still works.
- **Agent directory** lists full checkout paths and agent names. **Ports** opens
  the existing native dialog. **Back to T3** restores `odysseas-t3` immediately.
- Scroll horizontally across districts. All checkouts shown are already-open
  spaces: the city does not scan every repository or start/stop processes.

The mod uses cached, read-only Git identity lookups on each space's own machine,
just like the T3 project labels. It does not mutate repositories, settle agents,
or recreate terminals. The skyline/rain are local SVG art, not a web view.

### Native Development ports

**Ctrl+Space → o** opens `odysseas-ports` as a native, theme-aware dialog in
`odysseas` and `odysseas-t3`. It opens no terminal or tab. `ports` remains available
as the standalone TUI; existing Development ports tabs are not closed automatically.

- **Remote services:** actual remote → client port mappings, status, process,
  filter, Open, Copy URL, enable/disable, persistent labels/groups and ordering.
- **Local services:** client → remote mappings, including distinct ports, with
  explicit enable/disable. A failed but configured reverse mapping remains enabled
  until disabled; a discovered service is not exposed automatically.
- **Add mapping:** accepts a remote port, or `REMOTE_PORT:LOCAL_PORT` in Local
  services. Rejects reserved/invalid ports and already-enabled mappings, rather
  than accidentally toggling an existing one off.
- **Keyboard:** `1`/`2` switch direction, `/` filters, arrows or `j`/`k` select,
  Enter or `x` toggles, `m` adds a mapping, `r` refreshes. Remote services also has
  `l`/`g` for labels/groups, `[`/`]` for port order, `{`/`}` for group order.
  Escape cancels an edit first, then closes the dialog. Buttons do the same work.

**Controller routing matters:** portd runs on the client, owning the SSH connection
to its configured remote host. The default **This computer** source uses only
`http://127.0.0.1:43117`, not the selected space's machine or `PORTD_URL`.
Remote/local names describe the controller's ends, not a project's checkout.
Open uses the actual allocated local port, which may differ from the remote port.

An explicit **machine bridge** source uses `exec(..., {on: machine})` to reach
that machine's loopback reverse control channel. It may control another client's
daemon: the UI warns about this and never silently falls back to it. In bridge
mode Open asks that controller to open its client's browser; copied loopback URLs
also belong to that client, not necessarily the screen viewing them.

Transport is bounded `curl` (`curl.exe` on local Windows), with no proxy, shell
interpolation, public API, credentials or extra server. Bridge hosts need `curl`.
Existing portd authentication and loopback-only forwarding are unchanged. The mod
never starts/stops portd or service processes, and closing the dialog leaves all
mappings running. Native Linux is UI-tested; Windows transport has unit coverage,
not live Windows UI verification.

It polls every three seconds only while open and the window is active. Failed
reads retain stale rows but disable their actions. Writes are serialized; toggle
POSTs are never retried automatically. The UI asks for a fresh status after each
write. Mutations persist in portd, not the shared Herdr profile or mod state.

### Built-in panels

Keep the built-in **Priority agents**, pinned agents/peek, **Files**, **Changes**,
and **Worktree** panels. They already understand remote work. The personal layout
references these shipped mods rather than copying their code, so their fixes
continue to arrive with app updates.

**Changes' Commit stages all files (`git add -A`) before committing.** Use it for
review, and use LazyGit/explicit Git commands for selective commits in shared
working trees. Do not treat this as an auto-commit workflow.

The catalogue review did not justify installing third-party code during migration:

- [Last pane](https://github.com/ohneda/herdr-last-pane): useful idea, covered by our small compatibility helper.
- [Tmux prefix](https://herdr.dev/mods/herdrdev/tmux-prefix/): optional example popup;
  unnecessary with native sequences, and its repeat replay has Unicode/shifted-key caveats.
- [Open in VS Code](https://github.com/CacaoRick/herdr-open-vscode): consider only
  if VS Code Remote-SSH becomes part of the workflow; currently we use Neovim.
- Machines Monitor/Servers add polling or remote control and are not equally
  tested on Windows. Built-in connection/agent status is enough for now.
- Reviewer/Changes Plus/Git Graph add Git mutations or agent-start assumptions;
  defer until there is a concrete need. Some retain stage-all commit semantics.
- Terminals is a useful alternate minimal layout. Herdr 98 and the release-video
  layout examples are not the daily coding setup.

Sources: [app](https://github.com/herdrdev/herdr-app),
[mod/layout guide](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md),
[core machines](https://github.com/herdrdev/herdr-core/blob/master/docs/machines.md),
[mod security](https://github.com/herdrdev/herdr-app/blob/master/docs/security.md).

## Install/reinstall

Read upstream installers before running downloaded code. These helpers leave the
old TUI installed. Linux:

```sh
bash ~/.dotfiles/herdr-app/install.sh
```

Windows, after copying `windows/` and configuring SSH host `debina`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install.ps1
```

Normal Windows desktop launches must be **unelevated**. Launching a core through
Administrator SSH can prevent the user's normal desktop from connecting. The
initial remote setup uses an **on-demand**, least-privilege interactive scheduled
task `Herdr (Debina)`; it has no boot or login trigger. Regular Start-menu launches
run directly as the normal desktop user. The launcher never changes the system
PowerShell execution policy; Bypass is scoped to its process.

The app's own installer/update management remains upstream. An upstream reinstall
may reset the stock Herdr shortcut; the separately named **Herdr (Debina)**
launcher remains the synced entry point. Run our installer again after changing
launcher code. Profile edits alone need only sync, not reinstallation.

## Backups and rollback

- Linux: `~/.local/state/herdr-profile/backups/`, with `last-sync.json` alongside.
- Windows: `%LOCALAPPDATA%\herdr-profile\backups\`, with last-sync/error diagnostics alongside.
- A full pre-migration Omarchy app config backup was also saved in the Linux backup directory.

To roll back preferences, close the **client window only**, restore selected files
from a backup, and open the stock `herdr-app` (not `herdr-start`, which reapplies
the central profile). No core/session stop is required. Or use old `herdr-w` for
old sessions. Removing a client machine entry does not kill Debina's terminals.

## Tests

```sh
python3 -m unittest discover -s herdr-app/tests -p 'test_*.py' -v
node herdr-app/tests/actions.test.mjs
node herdr-app/tests/agent-context.test.mjs
node herdr-app/tests/prefix.test.mjs
node herdr-app/tests/ports.test.mjs
python3 herdr-app/tests/ui_smoke.py  # Xvfb, xdotool, Vulkan driver required
HERDR_TEST_LAYOUT=odysseas-t3 python3 herdr-app/tests/ui_smoke.py
bash shell/tests/test-dot-sync-only.sh
```

The UI test owns a private display, app home, runtime/state paths and core session;
it never sends test keys to the real desktop. It checks prefix dispatch, cancellation,
literal NUL delivery, immediate typing/focus restoration, click-away behavior, and
native fallback in other layouts. It saves private screenshots, including the
active footer badge, in `/tmp/herdr-ui-*`. A private in-memory portd API also
checks the native ports dialog, edits, toggles, manual mappings, errors and search
with actual keyboard input; it never modifies real tunnels. Run `tests/test_profile.ps1` on Windows to exercise its native
sync client in temporary directories. The app's `check` command works on Linux;
this release's headless Windows check reports `cannot open windows while headless`,
so validate Windows through live `status`/screenshots as well.
