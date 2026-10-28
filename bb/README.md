# Personal BB setup

This directory contains portable BB skills and the Project Scratch plugin.
It does not track the BB database, credentials, or private scratch text.

## Skills

```sh
bash ~/.dotfiles/bb/install-skills.sh
```

`dot` and `dot --stow-only` also run this installer. `dot --sync-only` only
updates the checkout; run this installer afterward on another machine.
BB's user-skill scanner needs regular files, so the installer copies the
managed skill files instead of using Stow symlinks. Edit the sources here,
then rerun the installer. New sessions discover the updated versions.

- `bro`: restate the last answer plainly.
- `handoff`: write a concise handoff in the OS temporary directory.
- `grill-with-docs`: work through design questions and maintain glossary/ADRs.
- `ponytail`: explicitly requested minimal implementation mode.
- `feature-session`: independent persistent BB feature threads, with optional
  worktree isolation and deliberate handoff rather than automatic supervision.

The first four retain their Pi manual-invocation metadata. The feature-session
skill adapts the Herdr conventions to BB's environment and thread lifecycle.
Use the Skills picker or name the skill explicitly in your request.

## Scratchpad

```sh
cd ~/.dotfiles/bb/plugins/bb-plugin-project-scratch
npm ci
bb plugin build
bb plugin install . --yes
```

Open a thread's panel New tab (+) actions and choose **Project scratch**.
See [the plugin README](plugins/bb-plugin-project-scratch/README.md) for storage,
import, recovery, shortcuts, and journal promotion behavior. Plugin installs
are explicit; running `dot` does not install or reload executable BB plugins.
