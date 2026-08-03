# macOS services

Mac-side services for remote Herdr development.

## Contents

- `dev.odysseas.portd.plist` starts portd. Development forwards and persisted
  Mac-to-Ubuntu service mappings are managed through `ports`; the launch agent
  contains no application-specific ports.
- `dev.odysseas.browser-control.plist` keeps the local Browser Control relay
  running.
- `browser-control-launch` applies the temporary unpacked-extension compatibility
  patch and starts the relay.

The launch agents invoke wrappers through `$HOME`; they do not contain a fixed
macOS username.

## Install

```bash
cd ~/dotfiles
stow -R -t ~ macos
npm install --global @opencode-ai/browser-control@0.3.2

launchctl unload ~/Library/LaunchAgents/dev.odysseas.portd.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/dev.odysseas.portd.plist
launchctl unload ~/Library/LaunchAgents/dev.odysseas.browser-control.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/dev.odysseas.browser-control.plist
```

Build `~/portd`, then link its binaries before loading the portd agent:

```bash
cd ~/portd
cargo build --release
mkdir -p ~/.local/bin
ln -sfn "$PWD/target/release/portd" ~/.local/bin/portd
ln -sfn "$PWD/target/release/ports" ~/.local/bin/ports
ln -sfn "$PWD/scripts/portd-launch" ~/.local/bin/portd-launch
```

Load the Browser Control extension unpacked in the dedicated **Pi** Chrome
profile from:

```text
$(npm root --global)/@opencode-ai/browser-control/extension/dist
```

Enable it only in that profile; two active copies compete for the relay.

## Operations

```bash
launchctl list | grep -E 'portd|browser-control'
curl -fsS http://127.0.0.1:43117/api/status | jq
ports  # press 1/2 or tab to switch forwarding direction
browser-control status

tail -f ~/.local/state/portd/portd.log
tail -f ~/.local/state/browser-control.log
```

The unpacked-extension patch is intentionally strict. If an npm update changes
the relevant Browser Control code, the launch agent fails rather than modifying
unknown code. Remove the patch after the official Store extension is available.
