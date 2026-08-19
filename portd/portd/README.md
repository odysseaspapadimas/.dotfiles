# portd

Automatic development-port forwarding for an SSH host.

- `portd` runs on the local client and owns one system OpenSSH ControlMaster
  connection. It discovers Ubuntu listeners and makes them available on client
  loopback, and discovers client listeners that can be exposed on Ubuntu loopback.
- `ports` is a Ratatui client for both directions. It works locally and on the
  remote host through the daemon's private SSH reverse control channel.
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

Use `1`, `2`, or `tab` to switch directions:

- **Client → Ubuntu** makes Ubuntu services available on client loopback. These
  ports are automatically forwarded through SSH.
- **Ubuntu → Client** exposes selected client-local services on Ubuntu loopback.
  Client IPv4 loopback listeners are discovered automatically, but are never exposed
  until enabled. Manual mappings may be added before a service starts. Enabled
  mappings persist and return after either the service or SSH reconnects.

Select a port and press `x` or Enter to toggle it. Press `m` to enter a manual
port. In the Ubuntu → Client view, enter either `PORT` for the same port at both
ends or `UBUNTU_PORT:MAC_PORT` for distinct ports.

In the Client → Ubuntu view, press `l` to add, edit, or clear a persistent label.
Labels are stored by the local daemon and appear in both the local and remote TUI.

Press `g` to assign a port to a named group. Ports render under group section
headers. Use `[` and `]` to move a port within its group, and `{` and `}` to move
the selected group. Group assignments and both orderings are persistent.

Remote ports from 1024 through 10000 are forwarded automatically. If a local
port is occupied, the next available port is chosen. The automatic range can be
changed with `portd --max-auto-port`.

Client-local services are managed persistently from the Ubuntu → Client view.
For example, an enabled `5037:5037` mapping gives Ubuntu's normal ADB client
secure access to a client ADB server without changing `ADB_SERVER_SOCKET`:

```text
Ubuntu 127.0.0.1:5037 -> SSH -> Client 127.0.0.1:5037
```

Both endpoints remain loopback-only. The legacy repeatable
`--reverse-forward REMOTE_PORT:LOCAL_PORT` option and
`PORTD_REVERSE_FORWARDS` remain available as enforced startup mappings. They are
written to persistent state and reasserted on every launch; remove the startup
setting before removing one permanently in `ports`.

## Remote Android devices

The dotfiles package installs `remote-adb`, a repository-independent helper. It
refuses to invoke ADB unless portd's `5037:5037` mapping is active, preventing an
accidental Ubuntu ADB server when the tunnel is down.

```bash
remote-adb doctor
remote-adb devices
remote-adb status
eval "$(remote-adb use SERIAL)"
remote-adb reverse                 # defaults to 8081 and 8000
remote-adb reverse 8081 9000
remote-adb reverse-list
remote-adb reverse-remove 8081
remote-adb reverse-remove-all
remote-adb recover
```

Set `REMOTE_ADB_REVERSE_PORTS` to change the defaults. For each device port the
helper resolves portd's current client-local mapping, so it also works when a
client port differs from the Ubuntu service port. Device mappings remain ADB state and
must be reapplied after a device or ADB-server reconnect; `recover` waits for the
selected device and applies them again. `ANDROID_SERIAL` is honored, and a sole
authorized device is selected automatically.

Plain `adb` also works on Ubuntu without environment variables while the tunnel
is active. Prefer `remote-adb` for recovery commands because an ordinary ADB
client may start a local Ubuntu server if portd is completely disconnected.

The launchd wrapper in `scripts/portd-launch` rotates daemon output at 1 MiB.
