# Dotfiles

Personal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Install

```bash
sudo apt-get install stow
git clone <your-repository-url> ~/dotfiles
cd ~/dotfiles
stow -t ~ pi herdr hunk portd nvim ghostty
```

## Packages

- `pi` — Pi settings, keybindings, themes, and locally maintained extensions.
- `nvim` — native-package Neovim workspace configuration used by the standalone Herdr editor.
- `ghostty` — Ghostty terminal settings and Catppuccin Mocha theme.
- `herdr` — Herdr keybindings, UI preferences, notifications, and custom commands.
- `hunk` — Hunk custom Catppuccin Mocha review theme.
- `portd` — automatic SSH development-port forwarding source and Herdr plugin.
- `macos` — Mac launch agents and local wrappers for portd and Browser Control; stow this package only on the Mac.

Sensitive and generated Pi state is intentionally excluded, including OAuth credentials, MCP credentials, sessions, package installs, caches, and review reports.

## Update links

```bash
cd ~/dotfiles
stow -R -t ~ pi herdr hunk portd nvim ghostty

# On the Mac:
stow -R -t ~ macos
```
