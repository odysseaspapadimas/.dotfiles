---
name: browser-control
description: Control the user's visible Mac Chrome from remote Herdr/Pi through portd and Browser Control. Use when asked to inspect, automate, test, or interact with a browser tab or remote development UI.
disable-model-invocation: true
---

# Browser Control

Browser Control runs deterministic Playwright against the user's dedicated
**Pi** Chrome profile on the Mac. It is a driver, not an agent.

Before using it, read [the version-matched upstream workflow](references/upstream-skill.md)
completely. Follow its inspect-act-verify loop and safety requirements.

## Remote Herdr Topology

This Ubuntu host reaches the Mac relay through portd's loopback-only SSH reverse
forward:

```text
Ubuntu browser-control :19989
  -> portd SSH reverse forward
  -> Mac Browser Control relay :19989
  -> Pi Chrome profile extension
```

Run normal `browser-control` commands on Ubuntu. **Never start
`browser-control serve` on Ubuntu.** If `browser-control status` cannot reach a
connected extension, report the failure instead of starting another relay.

Chrome runs on the Mac, so open remote development servers through their
**Mac-local portd mapping**, not the original Ubuntu port. Resolve it before
navigation:

```bash
curl -fsS http://127.0.0.1:43117/api/status \
  | jq '.tunnels[] | select(.state == "active") | {remote_port, local_port, label}'
```

For example, if Ubuntu `5173` maps to Mac `5174`, navigate Chrome to
`http://127.0.0.1:5174`.

## Normal Start

```bash
browser-control status
browser-control session new <task-name>
browser-control execute --session <task-name> 'return await snapshot()'
```

Prefer adopting an attached Pi-profile tab when authentication or existing
state matters. Keep dependent interactions in one `execute`, return concise
verification evidence, and use screenshots only when layout matters.
