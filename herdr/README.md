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

## Workspace editor

`prefix+f` runs a detached command that focuses or creates one Neovim tab for the current Git root and Herdr workspace, without showing an intermediate popup. `prefix+shift+f` similarly focuses or creates an editor split in the invoking tab. The standalone launcher lives at `~/.local/bin/workspace-editor` and accepts an optional `path[:line]`.

The launcher uses stable project labels and Neovim RPC sockets; it does not depend on Pi. Pi's `/view` command is only a compatibility bridge to the same launcher. Neovim saves one project-root session on clean exit and restores its buffers/windows when reopened; a project with no session starts in Neo-tree rather than the file picker.

`prefix+g` runs `workspace-git` in a modal popup. Inside one repository it opens LazyGit directly; at a non-Git umbrella root it discovers bounded immediate-child repositories, shows branch, dirty status, green added-line counts, and red deleted-line counts, and opens LazyGit for the selected repository. Install `lazygit` on `PATH`; `popup-env` keeps a missing-command error visible instead of silently closing.
