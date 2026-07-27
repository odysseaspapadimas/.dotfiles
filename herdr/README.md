# Herdr configuration

## Popup commands

Herdr servers intentionally run with a minimal `PATH`, and popup terminals do not inherit `HERDR_SESSION` or `HERDR_SOCKET_PATH`. Commands installed in `~/.local/bin` may therefore fail with status 127, while commands that invoke the Herdr CLI may accidentally query the default session.

Route local popup tools through the POSIX `popup-env` wrapper:

```toml
[[keys.command]]
key = "prefix+a"
type = "popup"
command = "/bin/sh \"$HOME/.config/herdr/popup-env\" project-scripts"
width = "82%"
height = "82%"
```

The wrapper:

- prepends `~/.local/bin` to `PATH`;
- discovers the named session from the popup's Herdr server ancestor;
- exports `HERDR_SESSION` and `HERDR_SOCKET_PATH`;
- keeps failures visible instead of silently closing the popup.

Use this wrapper for future local popup binaries. System commands that neither live in a user path nor call Herdr do not require it.
