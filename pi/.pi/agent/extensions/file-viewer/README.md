# File viewer

Project file viewing and editing for Pi.

## Usage

- `/view` — open/reuse the Herdr Neovim split with a centered `mini.pick` Git file finder active.
- `/view path/to/file` — open a file in the reusable split.
- `/view path/to/file:120` — open at line 120.
- `/view --tab path/to/file:120` — open in the reusable dedicated tab.
- `Ctrl+X f` — open the Neovim pane directly with `mini.pick` active while preserving the prompt draft.

Inside Herdr, files open in editable Neovim with bundled Catppuccin Mocha styling, `mini.icons`, and Neo-tree. The extension installs pinned `mini.nvim`, `neo-tree.nvim`, `plenary.nvim`, and `nui.nvim` checkouts under `~/.local/share/pi-file-viewer/` on first use. Hybrid line numbers are enabled: the current line shows its absolute number while surrounding lines show their relative distance.

Viewer keybindings:

- `Space` — leader
- `Space e` — toggle Neo-tree
- `Ctrl+P` — find files
- `Space f g` — live grep
- `Space f b` — buffers
- `Space b d` — close buffer
- `[b` / `]b` — previous/next buffer
- `Alt+J` / `Alt+K` — move the current line or visual selection The extension reuses one split and one dedicated tab per Pi pane and updates a running Neovim instance through its RPC socket.

Outside Herdr, the same command uses a read-only Pi overlay with line numbers and `j/k`, arrows, Page Up/Down, `g/G`, and `q`/Esc navigation. The overlay is limited to 2 MiB.

Explicit paths are resolved against the Git root (or cwd outside Git), must remain inside it, and symlinks resolving outside the root are rejected.
