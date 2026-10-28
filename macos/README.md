# macOS services

Mac-side services for remote Herdr development.

## Contents

- `dev.odysseas.portd.plist` starts portd against the `debina` SSH alias. Development
  forwards and persisted Mac-to-Debina service mappings are managed through `ports`; the launch agent
  contains no application-specific ports.
- `dev.odysseas.browser-control.plist` keeps the local Browser Control relay
  running.
- `browser-control-launch` applies the temporary unpacked-extension compatibility
  patch and starts the relay.
- `wake-ubuntu` sends a Wake-on-LAN packet through the router's UDP port 9
  forward and waits for the workstation to appear on Tailscale.

The launch agents invoke wrappers through `$HOME`; they do not contain a fixed
macOS username.

## Install

```bash
cd ~/.dotfiles
stow -R -t ~ macos
npm install --global @opencode-ai/browser-control@0.3.2

launchctl unload ~/Library/LaunchAgents/dev.odysseas.portd.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/dev.odysseas.portd.plist
launchctl unload ~/Library/LaunchAgents/dev.odysseas.browser-control.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/dev.odysseas.browser-control.plist
```

Run `dot` to build and install `portd` and `ports`, then link the macOS launch wrapper before loading the agent:

```bash
dot
ln -sfn "$HOME/.dotfiles/portd/portd/scripts/portd-launch" ~/.local/bin/portd-launch
```

Load the Browser Control extension unpacked in the dedicated **Pi** Chrome
profile from:

```text
$(npm root --global)/@opencode-ai/browser-control/extension/dist
```

Enable it only in that profile; two active copies compete for the relay.

## Update Portd

After syncing this repository on the **Mac**, rebuild the daemon and reload the
launch agent; a Git pull alone does not update the installed binary or running
process:

```bash
cd ~/.dotfiles
cargo install --path portd/portd --locked --root "$HOME/.local" --force
mkdir -p ~/.local/bin ~/Library/LaunchAgents
ln -sfn "$HOME/.dotfiles/portd/portd/scripts/portd-launch" ~/.local/bin/portd-launch
stow -R -t ~ macos

launchctl bootout "gui/$(id -u)/dev.odysseas.portd" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.odysseas.portd.plist"
curl -fsS http://127.0.0.1:43117/api/status | jq
```

Status should show `"host": "debina"`, `"connected": true`, and an active tunnel
for your dev server. Verify `ssh -o BatchMode=yes debina true` works on the Mac
without a prompt. Portd uses the Mac's existing SSH configuration and keys.

Remote loopback targets use `localhost`, supporting both IPv4-only and IPv6-only
dev servers (including Vite bound to `::1`). Open the tunnel's **local_port** on
the Mac, e.g. `http://127.0.0.1:5173`; it can differ from the remote port if that
port is already occupied locally. If a previously disabled port is listed,
enable it in `ports`.

## Operations

```bash
launchctl list | grep -E 'portd|browser-control'
curl -fsS http://127.0.0.1:43117/api/status | jq
ports  # press 1/2 or tab to switch forwarding direction
browser-control status
wake-ubuntu                 # wake and wait up to 3 minutes
wake-ubuntu status          # only check Tailscale availability
wake-ubuntu --timeout 300   # use a longer startup timeout

tail -f ~/.local/state/portd/portd.log
tail -f ~/.local/state/browser-control.log
```

`wake-ubuntu` defaults to the workstation's current public IPv4 address, UDP
port 9, Ethernet MAC address, and Tailscale DNS name. If the public address
changes, set `WAKE_HOST` to the new address (or preferably a dynamic-DNS name).
The target already has NetworkManager Wake-on-LAN set to `magic`; Wake-on-LAN
must also remain enabled in its firmware and the router's UDP forward.

The unpacked-extension patch is intentionally strict. If an npm update changes
the relevant Browser Control code, the launch agent fails rather than modifying
unknown code. Remove the patch after the official Store extension is available.
