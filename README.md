# Dotfiles

Shared CLI and development configuration for Omarchy, Ubuntu, and macOS, managed with [GNU Stow](https://www.gnu.org/software/stow/).

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
herdr-w             # Attach to the remote Ubuntu work session
```

Fish’s `~/.config/fish/fish_variables` is machine-local runtime state, not shared configuration. `dot` preserves existing values when converting old Stow symlinks to a real local file; Git and `dot`’s Stow invocation exclude that file. Shared path settings use session-global variables in `config.fish`, so starting or upgrading Fish does not dirty the repository. Other configuration changes still trigger `dot`’s normal commit-or-stash safeguard.

`herdr-w` expects an SSH host named `ubuntu`. SSH keys and `~/.ssh/config` remain machine-local and are intentionally not tracked. The current setup uses Ubuntu's Tailscale address.

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
