# project-scratch

Standalone private project scratchpad for Herdr. It replaces Pi's former `/scratch` extension and opens from any pane with `prefix+p`.

The editor is scoped to the canonical Git root, or to the canonical current directory outside Git. Scratch text lives outside the project under `${XDG_STATE_HOME:-~/.local/state}/herdr/project-scratch/<sha256>/scratch.md`, with private `0700` directories and `0600` files. On first use, an existing Pi scratch at `~/.pi/agent/project-state/<sha256>/scratch.md` is copied into the new location so old notes are preserved.

Scratch text stays local and is never added to Pi messages or model context. Promotion is the only operation that writes into the project: it appends the selected text, or the whole scratch when there is no selection, under a UTC dated heading in `.agents/project-journal.md` after an exact preview and confirmation.

## Keys

- Normal editor and selection keys are provided by `tui-textarea`; Shift+arrows selects text.
- `Ctrl+S`: save immediately.
- `Alt+T`: cycle current or selected lines through plain → unchecked todo → checked todo → plain.
- `Alt+S`: toggle strikethrough around the selection, or around the current line when nothing is selected. The editor renders a real crossed-out style while keeping hidden Markdown `~~` markers in storage.
- `F2`: preview and promote the selection, or the entire scratch.
- `F8`: confirm and clear the private scratch.
- `Esc`: save and close.
- Preview: arrows/Page Up/Page Down scroll, Enter appends, Esc cancels.

Changes autosave after 750 ms. Writes use same-directory temporary files and atomic rename.

## Build

```bash
cargo test
cargo build --release
ln -sf "$PWD/target/release/project-scratch" ~/.local/bin/project-scratch
```
