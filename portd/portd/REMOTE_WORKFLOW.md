# Local client and Ubuntu workflow

## Daily entry point

From the Omarchy or macOS client, attach with:

```sh
herdr --remote ubuntu --session work --remote-keybindings server
```

The remote `work` session is kept alive by `herdr-work.service`. Its `Luca`
workspace is rooted at `~/Luca`, the parent of `luca-backend` and `luca-ims`.

- Herdr prefix: `ctrl+space`
- Development ports: `ctrl+space`, then `o`
- Equalize three panes: `ctrl+space`, then `shift+e`
- Detach without stopping panes: `ctrl+space`, then `q`
- Ghostty quick terminal (separate local shell): `ctrl+backquote`

## Codex boundaries

- Run Codex CLI agents inside Herdr panes on Ubuntu. Herdr owns their terminal
  persistence, attention state, and native session restore.
- Use the Codex desktop app with remote host `ubuntu` when app-specific tools or
  threads are preferable. Point those threads at `~/Luca` or one of its repos.
- Both surfaces share Git state, so do not let two agents edit the same branch at
  the same time. Use a Git worktree when work must proceed in parallel.
- Do not synchronize live `.codex` databases, `node_modules`, `vendor`, or build
  output between the machines.

## Ports

`portd` runs on the local client and maintains one SSH control connection over
the `ubuntu` SSH alias. The Ubuntu `ports` client reaches it through a reverse
control channel, so browser opens and local listeners are created on the client.
On Omarchy it runs as `portd.service`; macOS uses its launch agent.

The Herdr plugin refreshes discovery when panes start or exit. The standalone
client remains available as `ports` on either machine. Press `1` for Ubuntu
services exposed on the client and `2` for client services exposed on Ubuntu.
Reverse service choices are persistent; `43117` is the only automatic internal
reverse because the remote client depends on it.

## Recovery

```sh
# Local forwarding status
curl -fsS http://127.0.0.1:43117/api/status | jq
systemctl --user status portd.service  # Omarchy

# Ubuntu Herdr status
ssh ubuntu 'systemctl --user status herdr-work'

# Reattach without Ghostty's initial command
herdr --remote ubuntu --session work --remote-keybindings server
```
