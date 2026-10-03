---
name: browser-control
description: Control the user's visible Chrome/Chromium on their remote desktop through portd and Browser Control. Use when asked to inspect, automate, test, or interact with a browser tab or remote development UI.
disable-model-invocation: true
---

# Browser Control

Browser Control runs deterministic Playwright against the user's dedicated
browser profile on their remote desktop (Omarchy/Hyprland or macOS). It is a
driver, not an agent.

Before using it, read [the version-matched upstream workflow](references/upstream-skill.md)
completely. Follow its inspect-act-verify loop and safety requirements.

## Remote Herdr Topology

This Ubuntu host reaches the remote desktop relay through portd's loopback-only
SSH reverse forward. The active desktop can be `omarchy-mac` (Linux/Hyprland)
or the MacBook; do not infer macOS from the Omarchy host's name.

```text
Ubuntu browser-control :19989
  -> portd SSH reverse forward
  -> Remote desktop Browser Control relay :19989
  -> Chrome/Chromium profile extension
```

Run normal `browser-control` commands on Ubuntu with
`BROWSER_CONTROL_AUTOSTART=false`. **Never start `browser-control serve` or run
`browser-control relay restart` on Ubuntu.** If `browser-control status` cannot
reach a connected extension, report the failure instead of starting another relay.
Coordinate upgrades and restart the relay on the actual desktop over SSH.

The browser runs on the remote desktop, so open development servers through their
**desktop-local portd mapping**, not an assumed Ubuntu port. Resolve it before
navigation:

```bash
curl -fsS http://127.0.0.1:43117/api/status \
  | jq '.tunnels[] | select(.state == "active") | {remote_port, local_port, label}'
```

For example, if Ubuntu `5173` maps to desktop port `5174`, navigate to
`http://127.0.0.1:5174`.

## Normal Start

```bash
export BROWSER_CONTROL_AUTOSTART=false
browser-control status
browser-control session new <task-name>
browser-control execute --session <task-name> 'return await snapshot()'
```

Prefer adopting an attached intended-profile tab when authentication or existing
state matters. Keep dependent interactions in one `execute`, return concise
verification evidence, and use screenshots only when layout matters.
