# Dotfiles

Personal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Install

```bash
sudo apt-get install stow
git clone <your-repository-url> ~/dotfiles
cd ~/dotfiles
stow -t ~ pi
```

## Packages

- `pi` — Pi settings, keybindings, themes, and locally maintained extensions.

Sensitive and generated Pi state is intentionally excluded, including OAuth credentials, MCP credentials, sessions, package installs, caches, and review reports.

## Update links

```bash
cd ~/dotfiles
stow -R -t ~ pi
```
