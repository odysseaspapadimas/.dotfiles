# Notification audio

`herdr-done.mp3` is the unmodified `assets/sounds/done.mp3` bundled with
[Herdr](https://github.com/ogulcancelik/herdr) by Oğulcan Çelik and contributors.
Copied from the locally installed Herdr source bundle, and verified byte-for-byte
as embedded in the installed Herdr binary. No custom sound override was present
in Omarchy's Herdr configuration.

SHA-256: `cb9c93492c808e33946edac2ab5915758267e65914bc4b794a5ca6dc6e655741`

Herdr is licensed under AGPL-3.0-or-later, with a commercial licensing option.
The bundled open-source license is preserved in `HERDR-LICENSE`.

`bb-notification.wav` is this audio decoded to mono 48 kHz 16-bit PCM, with
0.5 seconds of leading silence and 0.8 seconds of trailing silence for Bluetooth.
No replacement tune, normalization, or other audio effects are applied.
Regenerate it with `python3 generate-chime.py` (requires ffmpeg).
