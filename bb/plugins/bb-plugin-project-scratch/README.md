# Project Scratch for BB

Private notes alongside any BB thread. Open the thread's panel **New tab (+)**
actions and choose **Project scratch**. Threads in the same canonical Git root
(or the same canonical working directory outside Git) use the same notes on
that machine. Different worktrees have independent notes.

Notes open in a rich-text editor: todos are clickable checkboxes, completed
items are dimmed and crossed out, and strikethrough renders inline. Headings,
bold/italic, lists, quotes, and code also render while editing. Type `- [ ] `
at the start of a line to create a todo, or use **Todo / Alt+T**. **Strike /
Alt+S** toggles strikethrough on selected text (or the current line).
**Ctrl+Enter / Cmd+Enter** toggles the todo at the caret between done and not
done, in both rich text and Markdown source mode. It leaves ordinary text
unchanged. Enter continues lists; standard undo/redo shortcuts work in rich text.

Notes autosave after 750 ms and on leaving the editor. Save immediately with
Ctrl/Cmd+S. Storage, downloads, and journal promotion remain Markdown, not HTML.
**Markdown / Rich text** switches between source and rendered editing. In source
mode Todo cycles plain → unchecked → checked, as before. Merely opening notes
or switching modes does not normalize or save their contents. Rich-text edits
serialize supported formatting to Markdown and may normalize its whitespace.
Notes containing tables, images, or raw HTML stay in source mode to avoid
losing content the rich-text editor does not support.

**Promote… / F2** previews exactly what will be appended to
`.agents/project-journal.md`, including its UTC heading. A selection promotes
only that selection; otherwise the entire scratch is used. **Append to journal**
is the confirmation. Promotion keeps scratch contents. **Clear… / F8** requires
its own confirmation and never clears the journal.

## Privacy, recovery, and scope

- Scratch files live in this plugin's host-owned data directory under
  `scratch/<sha256-of-canonical-root>/scratch.md`. The scratch directory is
  mode 0700 and files are 0600 on Unix.
- No agent tools or instruction providers are registered. Opening, typing,
  and saving do not add notes to prompts or conversation history. Promoted
  journal content becomes an ordinary project file that agents can read.
- On first use for a root, existing Herdr notes at
  `${XDG_STATE_HOME:-~/.local/state}/herdr/project-scratch/<hash>/scratch.md`
  are copied, falling back to old Pi notes at
  `~/.pi/agent/project-state/<hash>/scratch.md`. Originals are unchanged.
  Later edits are independent; there is no two-way synchronization.
- Unsaved drafts also live in the authenticated browser's local storage,
  separately per thread and root, so closing a panel does not lose a pending
  draft. Successful saves remove that recovery copy. Clearing browser data
  removes unsaved recovery drafts, not notes already saved on the host.
- Concurrent BB saves use content revisions. A conflict preserves the local
  draft and offers download/reload; it never silently overwrites saved notes.
- Promotion previews are workspace-bound and expire after ten minutes or a
  host worker reload/idle eviction. Preview again if needed. Changed journals
  are rejected at confirmation. Retries of a successful preview token do not
  append twice during that worker's lifetime.
- Journal promotion refuses symlinked `.agents` directories and journal files.
  BB promotions cooperate using `.agents/.project-journal.bb-lock`. A crash
  during promotion may leave that lock; inspect the journal before manually
  removing it. External editors do not participate in this lock.
- Scratch text is limited to 512 KiB UTF-8; journals to 4 MiB. Notes remain
  portable Markdown files; rich text is an editing interface, not a new format.

## Install and develop

```sh
npm ci
bb plugin build
bb plugin install . --yes
bb plugin dev
```

The plugin uses the public SDK and a host entry, so filesystem operations run
on the machine owning the selected thread's environment. It does not assume
that the BB server and workspace are on the same machine.

```sh
npm test
npm run typecheck
```

Tests use temporary workspaces and BB's official backend/frontend harnesses.
They cover privacy modes, import, scope, conflicts, confirmation, recovery,
selection formatting, and stale previews. They do not modify real notes or
journals or call a model.
