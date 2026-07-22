# portd

Automatic development-port forwarding for an SSH host.

- `portd` runs on the Mac, owns one system OpenSSH ControlMaster connection,
  discovers remote TCP listeners with `ss`, and reconciles local forwards.
- `ports` is a Ratatui client. It works on the Mac and on the remote host through
  the daemon's SSH reverse control channel.
- Authentication is exclusively the existing OpenSSH key and `known_hosts`.
  There are no application tokens or pairing codes.
- Listener scans slow down while no forwarded services are active. Connection
  failures use capped exponential backoff, and repeated failures are logged only
  when their state changes.

## Development

```bash
cargo test
cargo build --release
```

Run the daemon in the foreground:

```bash
portd --host ubuntu
```

Open the TUI locally or after `ssh ubuntu`:

```bash
ports
```

Select a port and press `l` to add, edit, or clear its persistent label. Labels
are stored by the Mac daemon and appear in both the local and remote TUI.

Press `g` to assign a port to a named group. Ports render under group section
headers. Use `[` and `]` to move a port within its group, and `{` and `}` to move
the selected group. Group assignments and both orderings are persistent.

Remote ports from 1024 through 10000 are forwarded automatically. If a local
port is occupied, the next available port is chosen. The automatic range can be
changed with `portd --max-auto-port`.

Mac-local services can be exposed on remote loopback through the same SSH
ControlMaster. Repeat `--reverse-forward REMOTE_PORT:LOCAL_PORT`, or set a
comma-separated environment value:

```bash
PORTD_REVERSE_FORWARDS=21989:19989 portd --host ubuntu
```

This binds `127.0.0.1:21989` on Ubuntu and forwards it to
`127.0.0.1:19989` on the Mac. Both endpoints remain loopback-only.

The launchd wrapper in `scripts/portd-launch` rotates daemon output at 1 MiB.
