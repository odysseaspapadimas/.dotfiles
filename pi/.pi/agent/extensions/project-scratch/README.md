# Private project scratch

`/scratch` opens a large centered Markdown editor whose contents are private local state and are never added to Pi's messages or model context. Ctrl+X p opens the same editor while preserving the main prompt draft.

Storage is keyed by SHA-256 of the canonical Git root (or canonical cwd outside Git) at `~/.pi/agent/project-state/<hash>/scratch.md`; `project.json` beside it records readable root metadata. The directory is outside the project, uses private permissions, and cannot affect Git status or project search.

Commands:

- `/scratch` — edit; autosaves after 750 ms, Ctrl+S saves, Esc saves and closes.
- `/scratch show` — read-only Markdown viewer.
- `/scratch clear` — confirmed erase.
- `/scratch path` — show the private path.
- `/scratch promote` — edit a non-mutating copy/selection, inspect the exact append, then append it under a UTC dated heading in `.agents/project-journal.md`. A final confirmation offers to clear the private scratch; No/Esc keeps it.

Writes use same-directory temporary files and atomic rename. Private state files and directories are mode 0600/0700 where supported. Promotion is the only journal operation.
