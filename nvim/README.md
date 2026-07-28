# Neovim workspace configuration

A focused Neovim 0.12+ setup for the standalone Herdr `workspace-editor`. Plugins are managed by native `vim.pack`; commit `nvim-pack-lock.json` to keep installations reproducible.

Each canonical project root has a persistent `mini.sessions` session under Neovim's data directory. Cleanly leaving the editor records open buffers, windows, tabs, cwd, folds, and local options. Reopening restores that state. A project without a saved session starts with Neo-tree open; the file picker opens only when explicitly requested with `Ctrl+P`.

## Core workflow

- `Ctrl+P`: project files
- `Space f g`: live grep
- `Space f b`: buffers
- `Space f r`: recent project files
- `Space f d`: diagnostics
- `Space f s` / `Space f S`: document/workspace symbols
- `Space e`: toggle Neo-tree
- `Space g s`: Git-status tree; multi-repository workspaces first prompt for a repository
- `[b` / `]b`: previous/next buffer
- `Space b d`: close buffer

## Git

Gitsigns shows worktree and staged hunks in the sign column. Satellite adds a compressed scrollbar on the right edge of each editing window: colored marks show the approximate positions of added, changed, and deleted Git hunks across the whole file. For a non-Git workspace containing independent immediate-child repositories, the filesystem sidebar registers each repository and decorates files with its own status. Discovery is bounded to 1,000 real immediate-child directories and 32 exact Git roots. The dedicated Git-status source remains repository-specific, so `Space g s` shows a status summary picker with green additions and red deletions before opening the selected repository. Use `j` and `k` to move through that picker.

- `[c` / `]c`: previous/next hunk
- `Space h s` / `Space h r`: stage/reset hunk
- `Space h S` / `Space h R`: stage/reset buffer
- `Space h u`: undo staged hunk
- `Space h p`: preview hunk
- `Space h b`: blame line
- `Space h B`: toggle current-line blame
- `Space h d` / `Space h D`: diff against index/previous commit
- `Space g c`: file history picker
- `Space g h`: changed-hunk picker

Use Herdr `prefix+g` for full status, staging, branch, stash, and history operations. At an umbrella workspace such as `~/Luca`, it first shows the immediate-child repositories with branch, dirty status, green added-line counts, and red deleted-line counts, then opens LazyGit for the selected repository.

## LSP and formatting

Mason installs language servers for TypeScript/JavaScript, JSON, CSS, Rust, and PHP. It also installs Prettier, PHP CS Fixer, and the Tree-sitter CLI. Existing project-local Prettier installations take precedence.

Formatting runs on save:

- `Space c f`: format explicitly
- `:FormatToggle`: toggle format-on-save for the current buffer
- `:FormatToggle!`: toggle it globally
- `[d` / `]d`: previous/next diagnostic
- `Space d e`: diagnostic float
- `Space c a`: code action
- `Space r n`: rename symbol
- `Space l h`: toggle inlay hints

Long-running tests, services, logs, and terminals remain in Herdr panes rather than hidden Neovim terminal plugins.

## Maintenance

- `:lua vim.pack.update()`: review and update plugins
- `:Mason`: inspect language tools
- `:MasonToolsInstall`: install missing configured tools
- `:WorkspaceSessionSave`: explicitly save the current project session
- `:TSUpdate`: update installed Tree-sitter parsers after plugin updates
- `:checkhealth`: inspect the complete setup
