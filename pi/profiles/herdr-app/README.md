# Automatic Herdr App integration

**Use ordinary `pi` on Debina.** Windows and Omarchy are screens onto the same
core-owned terminals. No profile picker, desktop binding or additional login.
Pi's existing `~/.pi/agent/` settings, authentication, packages and session history
are reused in place. Nothing copies credentials to a desktop.

The app's Pi menu launches `pi`. `pi-app` is only a backward-compatible alias;
old saved `--app-client` arguments are ignored. The experimental separate profile
under `~/.pi/profiles/herdr-app/` is retired, not deleted; its files are retained
so an already-running experimental process or transcript is not destroyed.

## Runtime adapters

`pi/.pi/agent/extensions/herdr-app.ts` activates only inside herdr-core, identified
by HC_TERMINAL_ID/HC_TERMINAL_SOCKET. Explicit old Herdr context takes precedence
for nested old TUI sessions. Old Herdr's status and side-chat adapters stay out
of new-core sessions; neutral extensions, settings, skills and pi_sessions stay
shared. The new adapter removes the old Herdr-only skill descriptions from its
model prompt. No separate Pi installation is needed.

New sessions discover the integration automatically. Existing ordinary Pi
processes can load it with `/reload`; this does not restart their process or
replace their conversation. Do not send reload into a busy agent or one with an
unsubmitted draft. An experimental process retains its launch-time agentDir until
it exits; changing a launcher cannot rewrite an existing process's environment.

## Automatic window control

The `herdr_app` tool exposes `current`, `ls`, `status`, `commands`, `do`, `shot`,
and `clients`. `current` finds the **calling core terminal**, not whichever tab
happens to be selected on the first desktop.

```sh
herdr-ui current
herdr-ui ls
herdr-ui do pane.focus '{"terminal":"t7"}'
herdr-ui do layout.switch '{"name":"odysseas"}'
```

No `--client` is needed. The helper discovers reachable configured windows using
read-only queries over verified SSH. Debina-only shared structure is changed
**once**; requested navigation/layout operations are mirrored to online windows.
Creation of a space, tab or split mirrors focus to the new terminal, not a second
creation. Offline screens are reported, not launched. When a mirror fails after
creation, the successful creation and partial-view errors are returned together;
mutations are never automatically retried on another desktop.

This mirrors **agent-issued** navigation, not every mouse click. Stock Herdr keeps
manual focus/zoom screen-local. Shared spaces/tabs/splits and live terminal output
remain common to every screen regardless of focus. If a desktop is closed, the
work keeps running on Debina. A disconnected desktop sees the shared structure
again after reconnecting; desktop-only view commands aren't queued for replay.

`--client omarchy|windows|debina` remains a troubleshooting/explicit user-requested
override, not a per-session selection. `shot` retrieves the first reachable
window's PNG (or the explicitly requested screen). Always inspect returned IDs;
automatic operations qualify bare Debina IDs for each screen. Only allowlisted
commands are exposed; close/kill requires explicit IDs and `--allow-destructive`.
App/core stop, restart, reset, update and quit are not exposed.

Machine addresses and SSH identities stay in `~/.config/pi-app/clients.json`.
The bridge starts no service, reverse tunnel or public listener and weakens no
host-key checks. No private keys are distributed.

Use native `hc` and the shared `pi_sessions` for background agents. Children launch
ordinary `pi`; they do not need a chosen desktop. pi_sessions focuses core
terminals through the same automatic bridge.

## Existing old Herdr work

The live **Existing Herdr → Running sessions** space is a single terminal client
attached to your existing old Herdr server. Both desktops can access the same
old running agents there without moving or restarting them. This is a compatibility
view, **not** conversion of old tabs to native new-core tabs. Do not start a second
Pi instance against an already-running transcript.

The outer app uses Ctrl+Space. Inside the compatibility view, press Ctrl+Space
**twice** to pass the prefix to old Herdr, then its usual action key; mouse
navigation also works. Closing the app window leaves work running. Avoid closing
the compatibility pane unless you intend to close that view client (the old
server and its agents remain independent).

## Install and test

```sh
python3 ~/.dotfiles/pi/profiles/herdr-app/install.py
python3 -m unittest discover -s pi/profiles/herdr-app/tests -p 'test_*.py' -v
node pi/profiles/herdr-app/tests/smoke.mjs
node pi/.pi/agent/extensions/tests/run-pi-sessions.mjs
# Live: owns a temporary space, uses existing login, restores both screens.
python3 pi/profiles/herdr-app/tests/live_shared.py --run
```

Desktop keys/themes/mods/program definitions continue syncing from
`~/.dotfiles/herdr-app/profile/` via the existing `herdr-start`/`herdr-profile`
launchers. Do not sync whole app homes, sockets or runtime state.
