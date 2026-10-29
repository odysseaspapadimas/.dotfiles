# On-demand Omarchy browser workspace

The skill bundles two standard-library Python programs. `scripts/browser_workspace.py`
runs on Debina/Ubuntu. It sends `scripts/desktop.py` over authenticated SSH stdin;
no remote script installation, dotfiles sync, or daemon is needed. There is no
per-agent MCP process. The existing desktop relay is shared across CLI clients.

## Commands

```sh
python3 <skill-directory>/scripts/browser_workspace.py ensure
python3 <skill-directory>/scripts/browser_workspace.py ensure --session agent-my-task
python3 <skill-directory>/scripts/browser_workspace.py ensure --read-only
python3 <skill-directory>/scripts/browser_workspace.py status
python3 <skill-directory>/scripts/browser_workspace.py url http://localhost:5173/path
```

`ensure` is intentionally mutating: it can open the managed Chromium window, put it
on the requested workspace, start an inactive desktop `portd.service`, enable the
missing `19989:19989` reverse mapping, and create a Browser Control session/tab.
`status` and `url` are observational. All output is bounded JSON except `url`,
which prints a URL. Normal errors go to stderr with a nonzero exit status.

Defaults: `--desktop odysseas@omarchy-mac`, `--workspace 3`, `--profile 'Profile 1'`,
`--timeout 40` seconds per startup stage. `BROWSER_CONTROL_DESKTOP` overrides the
SSH target. An omitted session id is randomly generated; use the returned explicit
id for all subsequent calls. `--read-only` requires a new or verified read-only
session; it does not silently change an existing writable session.

The desktop must use Hyprland's Lua dispatcher API (tested on 0.56.2). The helper
uses `hl.dsp.exec_cmd`, `hl.dsp.window.move`, and `hl.dsp.focus`, not legacy dispatch
argument syntax. The selected Chromium profile must already contain the enabled Browser Control
extension. Profile data, cookies, and credentials are never copied or edited. Keep Browser
Control enabled only in the intended automation profile: one relay accepts one
browser/profile. An already-connected unmanaged browser blocks bootstrap rather
than being disconnected or replaced.
The relay is allowed to autostart **only on Omarchy**. On the development host,
all CLI calls use `BROWSER_CONTROL_AUTOSTART=false` and port 19989.

## Window ownership and limitations

The desktop helper identifies a fresh window by a unique bootstrap page title,
then records its exact Hyprland instance, address, PID, and profile in
`~/.local/state/browser-workspace/window.json` on Omarchy. A pending unique title
is saved before launch, allowing safe recovery of that exact window after a startup
timeout; Chromium's title suffix is accounted for. Subsequent calls reuse
only that window. It does not guess that an arbitrary existing Chromium window
belongs to automation. A stale record after browser/compositor restart is harmless
when Chromium is closed: the next call creates a new managed window.

This initial implementation deliberately requires **one Chromium window**. Other
browsers such as Helium are unaffected. Browser Control currently creates tabs
without choosing a window id, so multiple Chromium windows could route new tabs
to the wrong place. Rather than move personal windows or pretend this is reliable,
the helper refuses that state. Close Chromium yourself and retry to establish the
managed window, or handle a multi-window workflow explicitly outside the helper.
Session-owned tabs from multiple agents share this window but have separate ids.

The helper does not switch to workspace 3 deliberately. If launching the app
requests focus anyway, it restores the previous window when possible. Tab
navigation, handoffs, or recording may still activate the browser as documented
by Browser Control; this is not an absolute background-execution guarantee.

A desktop lock serializes window/session bootstrap across hosts. A development-host
lock serializes tunnel setup across local agents. A stored pending reverse mapping
is waited for, never toggled off. A conflicting mapping is an error. Do not change
the same portd mapping interactively during bootstrap. An exact relay build and
session creation timestamp comparison catches a tunnel connected to another
active desktop in the normal case; this is a consistency check, not a new
network-authentication mechanism. All transport remains existing SSH and loopback.

## Screenshots and artifacts

Execute snippets run on the **desktop relay**, not the development host. Files
written by screenshot, recording, capture, `fs`, etc. live on Omarchy. The CLI's
JSON results travel back to Debina, but files do not. Use SSH/SCP for transfer.

For a screenshot, run this in one Bash invocation (replace the explicit session
id, and use the same desktop target as `ensure`):

```bash
set -euo pipefail
desktop=${BROWSER_CONTROL_DESKTOP:-odysseas@omarchy-mac}
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5)
remote_dir=$(ssh "${ssh_options[@]}" "$desktop" 'mktemp -d /tmp/browser-control.XXXXXXXX')
local_dir=$(mktemp -d /tmp/browser-control.XXXXXXXX)
BROWSER_CONTROL_AUTOSTART=false BROWSER_CONTROL_PORT=19989 \
  browser-control execute --session <id> --json \
  "await page.screenshot({path: '$remote_dir/screenshot.png', scale: 'css'}); return {url: page.url()}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r.get("ok"), r; print(json.dumps(r))'
scp -q "${ssh_options[@]}" "$desktop:$remote_dir/screenshot.png" "$local_dir/screenshot.png"
chmod 600 "$local_dir/screenshot.png"
ssh "${ssh_options[@]}" "$desktop" "rm -- '$remote_dir/screenshot.png'; rmdir -- '$remote_dir'"
printf 'Local screenshot to inspect with read: %s/screenshot.png\n' "$local_dir"
```

Both directories are private (`mktemp -d`); the local path is fresh, so SCP cannot
overwrite an existing artifact. Use the printed local path with the agent's
image-capable `read` tool. Copy recordings/captures similarly, preserving upstream
redaction and secret-handling rules. Never copy a browser profile or secret store
just to obtain an artifact. Clean up only the exact temporary files you created.

## Recovery

- SSH fails: configure the user's key and known-host entry normally. The helper
  does not accept unknown host keys or prompt for passwords.
- No/multiple Hyprland sessions: select/log into the intended desktop; no GUI
  process is launched into an arbitrary SSH display.
- Unmanaged/multiple Chromium windows: leave personal windows untouched; ask the
  user to close Chromium or handle the intended tab explicitly.
- Extension absent/disabled: load/enable the unpacked extension once in the chosen
  profile. The helper never edits Preferences to bypass extension permissions.
- Relay stale/incompatible: coordinate a desktop-side upgrade/reload. Never replace
  the relay automatically or start a fallback on Debina.
- Missing desktop development URL mapping: start/forward the actual development
  service, then resolve it again. Never assume equal port numbers.
- A failed attempt can leave its managed window/session open for diagnosis. Do not
  remove other sessions or delete the ownership record while that window is open.

## Tests

From the dotfiles checkout:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s pi/.pi/agent/skills/browser-control/tests -v
```

These tests mock all external operations. A live smoke test should begin with
Chromium closed, run `ensure`, verify the window on workspace 3 and extension
connection, repeat `ensure --session <id>` to prove reuse, then execute a harmless
page read and screenshot through the Debina CLI, then copy the desktop-side image
back through SCP and inspect it locally. Delete only the smoke
test session afterward; leave the shared browser window and relay available.

## Pi configuration

Set the machine-local `~/.pi/agent/mcp.json` browser-control entry to
`"enabled": false`. The skill remains automatically discoverable without
`disable-model-invocation: true`. Restart Pi or `/reload` existing sessions to
unload their old MCP adapters; do not interrupt other agents just to reclaim RAM.
MCP configuration is machine-local and intentionally not committed to dotfiles.
