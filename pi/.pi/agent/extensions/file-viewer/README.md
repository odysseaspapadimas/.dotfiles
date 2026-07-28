# File viewer bridge

Pi bridge to the standalone Herdr workspace editor.

## Usage

- `/view` — open or reuse the project editor's dedicated Herdr tab. A restarted editor restores its workspace session; a new workspace starts with Neo-tree open.
- `/view path/to/file` — open a project file in the dedicated editor tab.
- `/view path/to/file:120` — open at line 120.
- `/view --split path/to/file:120` — open in a reusable split beside Pi instead.
- `/view --tab ...` — explicit alias for the default dedicated-tab behavior.
- `Ctrl+X f` — invoke `/view` while preserving the prompt draft.

Inside Herdr, this extension delegates to `~/.local/bin/workspace-editor`. Pi no longer installs Neovim plugins or owns the editor pane, process, or RPC socket. Editor instances are scoped by canonical project root and Herdr workspace, so the same editor can be reused from any Pi pane in that workspace.

Outside Herdr, explicit paths still use a read-only Pi overlay with line numbers and `j/k`, arrows, Page Up/Down, `g/G`, and `q`/Esc navigation. The overlay is limited to 2 MiB. The file picker is only available through Herdr.

Explicit paths are resolved against the Git root (or cwd outside Git), must remain inside it, and symlinks resolving outside the root are rejected.
