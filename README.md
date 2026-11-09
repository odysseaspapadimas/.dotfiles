# Dotfiles

Shared CLI and development configuration for Omarchy, Debina, Ubuntu, and macOS, managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Bootstrap

On a fresh Omarchy Quattro installation, run one command:

```bash
git clone https://github.com/odysseaspapadimas/.dotfiles.git ~/.dotfiles && ~/.dotfiles/shell/.local/bin/dot
```

`dot` pulls with `--ff-only`, detects and offers to restore the encrypted Quattro migration archive from removable media, installs the personal CLI tools, installs Herdr and Something X, selects Pi as the default Omarchy agent, builds the repository's Rust helpers, sets Fish as the login shell, restows every package, and enables the Portd and Syncthing user services.

Rust build output is kept under `~/.cache/dotfiles-build`, not inside the repository. CLIamp is intentionally not reinstalled.

## Daily use

```bash
dot                # Pull, bootstrap tools, and restow
dot --stow-only    # Restow without pulling or building
dot --sync-only    # Git pull only; do not bootstrap, restow or enable services
dot --packages-only # Reconcile shared Pi npm packages; no pull or bootstrap
pi-packages --check # Preview package drift without changes (exit 1 if needed)
herdr-w             # Attach to Debina's default session
```

Fish’s `~/.config/fish/fish_variables` is machine-local runtime state, not shared configuration. `dot` preserves existing values when converting old Stow symlinks to a real local file; Git and `dot`’s Stow invocation exclude that file. Shared path settings use session-global variables in `config.fish`, so starting or upgrading Fish does not dirty the repository. Other configuration changes still trigger `dot`’s normal commit-or-stash safeguard.

`herdr-w` expects an SSH host named `debina` and attaches to its `default` session. Set `HERDR_DEV_HOST=ubuntu HERDR_DEV_SESSION=work` to use the Ubuntu fallback. SSH keys and `~/.ssh/config` remain machine-local and are intentionally not tracked.

### Sharing across machines

The Git remote is the source of shared dotfiles. Commit/push intentional changes, then run `dot --sync-only` on the other machines. It refuses dirty checkouts and pulls with `--ff-only`, without adopting files, rebuilding tools, changing login shells, restowing platform packages, or starting services. Do not Syncthing `.git` directories. Debina/Ubuntu should normally use this mode; full `dot` remains a desktop/fresh-machine bootstrap.

`pi/.pi/agent/settings.json` is a portable initial template, not live machine state. `dot` converts an old settings symlink to a private local file without losing its contents; Stow excludes the template. Device IDs, changelog state, provider logins and MCP configuration remain local. To apply later preference changes, update the local Pi settings deliberately; Git pulls do not overwrite them. Credentials, installed dependencies and runtime state are never published.

### Shared Pi packages

[`pi/packages.json`](pi/packages.json) is authoritative for **personal npm package declarations**. Edit and commit that list to add or remove a shared package. On each machine, pull the commit and run:

```bash
dot --sync-only
dot --packages-only
```

If there are unrelated uncommitted changes, reconcile the checkout safely before pulling; `--packages-only` can still apply the currently checked-out manifest without pulling. To preview changes, run `pi-packages --check` (or `python3 ~/.dotfiles/shell/.local/bin/pi-packages --check` before restowing the new command).

Reconciliation uses `pi install`/`pi remove`, installs missing packages before removing extras, and saves a private local settings backup under `~/.pi/agent/dotfiles-package-backups/` before changes. Removing an npm package from the list removes its personal registration and installation on the next reconciliation. Already configured resource filters are retained. Local-path and Git packages remain machine-local; project package declarations are not managed. The command respects `PI_CODING_AGENT_DIR`.

Full `dot` also reconciles packages; `--sync-only` and `--stow-only` do not. Reconciliation does not update existing unpinned packages just to chase registry releases; use `pi update --extensions` deliberately for that. The list excludes `rpiv-todo` and the upstream compaction npm package: compaction is supplied by the repository's local fork. No other settings, credentials, services or running sessions are changed. Run `/reload` in existing Pi sessions when idle after package changes.

Portd defaults to Debina on both Omarchy and macOS. Machine-local systemd overrides remain outside this repository, and pulling dotfiles does not rebuild Portd or restart it. For the Mac rebuild/reload steps, see [macOS services](macos/README.md#update-portd).

## Herdr desktop app

The new app uses the [shared Herdr profile](herdr-app/README.md), separate from the older TUI configuration. Open **Herdr (Debina)** or run `herdr-start` on Omarchy/Windows: it fetches allowlisted keys, styling, and personal layouts/mods from `~/.dotfiles/herdr-app/profile/` on Debina before opening the local client. Agents and terminals remain on Debina. Saved profile edits publish over SSH without pulling the whole repository; commit them separately for history. Runtime/window state and SSH credentials remain machine-local.

Install the Linux launcher with `bash ~/.dotfiles/herdr-app/install.sh`; Windows has a native PowerShell installer under `herdr-app/windows/`. The old `herdr-w` command remains available for existing TUI sessions.

## Packages

- `shell` — Fish, Starship, `dot`, and `herdr-w`.
- `pi` — Pi settings, keybindings, themes, skills, and locally maintained extensions. Use `/skills` to switch dotfiles-managed skills between automatic and manual-only.
- `nvim` — Neovim workspace configuration used by the standalone Herdr editor.
- `ghostty` — Ghostty settings and Catppuccin Mocha theme.
- `kitty` — Kitty settings and Catppuccin Mocha theme.
- `omarchy` — Personal shell layout, custom plugins and hooks, menu/branding overrides, and custom themes.
- `herdr` — Herdr keybindings, UI preferences, custom commands, and helper-tool source.
- `hunk` — Hunk Catppuccin Mocha review theme.
- `portd` — SSH development-port forwarding, Linux user service, and Herdr plugin.
- `macos` — Mac launch agents and wrappers; stow only on macOS.
- `luca` — Luca ticket orchestration skill, local environment helper, and `~/Luca/AGENTS.md`. MySQL credentials remain machine-local in `~/.config/luca/local.env`.

Embedded Rust source and tests are excluded from Stow, so they no longer create `~/portd`, `~/project-scratch`, `~/project-scripts`, or `~/tests` links.

Sensitive and generated state is excluded, including SSH keys, credentials, Pi sessions, package installs, build output, caches, Herdr sessions, and logs.

## Platform-specific setup

On macOS:

```bash
cd ~/.dotfiles
stow -R -t ~ macos
```
