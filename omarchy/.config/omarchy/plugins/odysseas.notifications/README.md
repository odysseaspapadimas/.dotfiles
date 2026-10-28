# Personal notifications with BB chime

This is the existing Omarchy-Mac `odysseas.notifications` clone, now tracked
in dotfiles. Its notification cards, history, DND, and click actions are kept.

Native BB notifications (`desktop-entry=bb-desktop`, or app name `bb` when no
desktop entry is provided) play Herdr's original **done** sound. Other applications
remain silent. This is an Omarchy-side feature; BB still decides which thread
events produce a notification. Completion and needs-input use the same chime:
BB's desktop notification payload does not supply a reliable event-kind hint.

- DND and the sender's `suppress-sound` hint silence the chime.
- At most one sound every three seconds; simultaneous sounds do not stack.
- Changed live notification content can chime because Electron reuses ids.
  Image-only updates, restored popups, and history replay do not chime.
- Playback uses `pw-play --volume=0.65`, following the system's current output
  without changing the default device or master volume. Leading/trailing silence
  accommodates Bluetooth startup/drain latency. It never targets raw speakers.
- Keep `pw-play` (PipeWire) installed. Playback errors go to Quickshell's log.

The unchanged upstream MP3, attribution, and license are kept under `sounds/`.
`sounds/generate-chime.py` decodes it and adds Bluetooth silence padding; run it
with Python 3 and ffmpeg when rebuilding `sounds/bb-notification.wav`.
Neither Python nor ffmpeg is used at notification time. See `sounds/SOURCES.md`.

Test from the dotfiles root:

```sh
node --test omarchy/tests/notification-sound.test.cjs
```

The live Omarchy plugin directory should link to this directory. Omarchy watches
local plugin files; `quickshell ipc --pid <shell-pid> call shell rescanPlugins`
can rescan them. Qt may keep cached QML or stale directory metadata after switching
a plugin directory to a symlink. If the service is stale or reports a file-name
case mismatch, run `omarchy-restart-shell` once (without restarting applications
or the compositor).
Send a real BB test from the BB instance the desktop client is connected to:

```sh
bb push-notifications test desktop --json
```

Omarchy-Mac's pre-change plugin was backed up under
`~/.local/state/omarchy/plugin-backups/` before deployment. No notification
history or user DND state belongs in this directory.
