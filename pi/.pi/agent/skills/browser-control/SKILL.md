---
name: browser-control
description: Inspect, automate, test, or interact with the user's visible browser on Omarchy from Debina/Ubuntu. Automatically prepare Chromium on workspace 3 over SSH, then use the Browser Control CLI through portd; no MCP server or manual browser startup is needed.
---

# Browser Control (CLI)

Use this skill automatically when browser interaction, authenticated page inspection,
or real UI testing is needed. Browser Control is a deterministic Playwright driver,
not another agent. Read [the version-matched upstream workflow](references/upstream-skill.md)
completely before browser work; follow its inspect–act–verify loop and safety rules.

## Start automatically

Resolve `scripts/browser_workspace.py` relative to this skill's directory. Run it
with Python 3; it has no dependencies beyond the standard library and the installed
SSH / Browser Control CLIs. Do not ask the user to open Chromium first:

```bash
python3 <skill-directory>/scripts/browser_workspace.py ensure
```

For inspect-only tasks, append `--read-only`. The command returns JSON with a
**session id** and a continuation command. Keep that id for every later call.
To resume a known session, use `ensure --session <id>`. Never rely on the shared
CLI "current session", and never issue bare `execute` repeatedly: that creates
new sessions/tabs. Use separate ids for independent tasks/agents.

`ensure` defaults to SSH target `odysseas@omarchy-mac`, Chromium `Profile 1`, and
workspace **3**. `BROWSER_CONTROL_DESKTOP` or `--desktop` can select another SSH
target, but this bootstrap supports **Omarchy/Hyprland only**, not macOS. Do not
silently choose another desktop if SSH fails. Normal SSH key/known-host setup,
an unlocked/logged-in desktop, and an installed/enabled extension are prerequisites.

The helper:

1. Uses verified, non-interactive SSH and the running compositor's environment.
2. Launches a uniquely identified Chromium window on workspace 3, or reuses only
   its own recorded window. It preserves the previous focus when possible.
3. Refuses unmanaged/multiple Chromium windows or ambiguous Hyprland sessions;
   it never moves an arbitrary personal browser window. Use the automation
   profile/window for Chromium and your ordinary browser separately.
4. Starts `portd.service` only if absent, and lets an ordinary desktop-side CLI
   operation start a missing relay. It never restarts or replaces a running relay.
5. Ensures the loopback-only portd reverse mapping is enabled, verifies the
   forwarded relay/session matches the selected desktop, and reads the live page.

Startup is locked against concurrent agents. New session ids are unique; rerunning
`ensure --session <id>` should reuse the same window/session. See
[helper details and tests](references/workspace-helper.md) for recovery and configuration.

## Remote topology and CLI calls

```text
Debina/Ubuntu browser-control :19989
  -> portd SSH reverse forward
  -> Omarchy Browser Control relay :19989
  -> Chromium Profile 1 extension
```

For **every development-host Browser Control call**, set both environment variables
(the helper already does so internally):

```bash
BROWSER_CONTROL_AUTOSTART=false BROWSER_CONTROL_PORT=19989 \
  browser-control execute --session <id> --json 'return await snapshot()'
```

**Never start `browser-control serve` or run `browser-control relay restart` on
Debina/Ubuntu.** A missing tunnel must not accidentally create a relay on the wrong
machine. Keep both ends loopback-only; do not expose the unauthenticated relay to
the LAN or Tailscale. Never use `--no-sandbox`, public remote debugging, or modified
browser security settings to recover.

If startup fails, report the exact prerequisite/error. Do not loop through new
profiles, reset sessions, restart the relay, or kill browsers. Coordinate upgrades
and any necessary relay restart on the actual desktop with other agents first.

## Development URLs

Chromium's `localhost` means **Omarchy**, not Debina. Resolve the actual current
portd mapping before navigation, including when ports differ:

```bash
python3 <skill-directory>/scripts/browser_workspace.py url http://localhost:5173/path
```

For example, development-host port `5173` may map to desktop port `5174`; use the
returned `http://127.0.0.1:5174/path`, not the assumed original port. A missing
mapping is an error, not permission to navigate to an unrelated local service.

## Inspect, act, verify

Inspect the real page first. Keep dependent actions in one execute and return
concise outcome evidence. Use `--json` and check `ok`, not just shell exit status.
Read `page.url()` when a snapshot is empty. Use the explicit session id throughout.

**Execute code runs inside the relay on Omarchy**, including Node filesystem
operations. Screenshot, recording, and network-capture paths therefore refer to
Omarchy, even when the CLI command runs on Debina. Do not assume a returned path
exists locally. For visual evidence, save into a fresh private directory on the
desktop, copy the image back through verified SSH, and inspect the **local** image
with the agent's `read` tool. Follow the complete
[screenshot transfer example](references/workspace-helper.md#screenshots-and-artifacts).

New session-owned tabs need no manual toolbar attachment. Adopting an existing
personal tab still requires the user to attach that tab with the extension's
button. Never bypass that boundary. Use `handoff()` for passkeys, 2FA, CAPTCHAs,
payments, and protected password-manager prompts; user acknowledgment is not proof
of success, so verify the destination afterward.

When finished, delete **only your own explicit session** unless follow-up work is
expected. Keep the shared Chromium window, extension, and relay running for other
agents. Deleting a session releases adopted user tabs without closing them:

```bash
BROWSER_CONTROL_AUTOSTART=false BROWSER_CONTROL_PORT=19989 \
  browser-control session delete <id>
```
