# Next-step suggestions

Optional, contextual follow-ups underneath the latest completed answer, shown as
an above-editor widget. Requires Pi **1.5.0+** (`registerMarkdownTransformer`).
Inspired by [Box Yard](https://github.com/agentSystemLabs/box-yard)'s next-step
chips; this is an independent implementation using Pi's extension APIs.

## Model, latency, and cost

Suggestions come from **the active chat model in the same response**. Switching
models also switches the suggestion model. There is no separate model selection,
API key, background agent, request, retry, timer, or network service.

A stable `next_steps` prompt section asks for zero to three concrete follow-ups.
When useful, the model appends a trailing HTML-comment block containing a JSON
array. The Markdown transformer hides that block while streaming and on restore.
The original assistant message is never rewritten: signatures, usage, model IDs,
and text remain intact in Pi's session history and provider replay. The hidden
payload therefore also remains in raw exports/copy operations and model context;
it is UI metadata, **not a secret**.

The additional prompt instructions and suggested text use some tokens. There is
no extra generation round trip, but generating those tokens can extend the
response slightly. Suggestions are best-effort: missing, malformed, overlong, or
unsafe payloads produce no actions, not a repair request. Code-fenced examples
are not treated as payloads.

## Controls

| Control | Action |
|---|---|
| **Ctrl+X, then p** | Open the keyboard picker without submitting/changing the current draft. |
| Click a suggestion row | Insert it into the editor (fullscreen mode). |
| `/next-steps` | Open the same picker. |
| `/next-steps 1` (or `2`, `3`) | Insert a numbered suggestion. |
| `/next-steps send` | Pick a suggestion and explicitly send it immediately. |
| `/next-steps send 1` | Explicitly send the numbered suggestion. |
| `/next-steps off` / `on` | Disable/enable suggestions for this session branch. |
| `/next-steps status` | Show enabled state and current model. |

Picking or clicking **never sends automatically**. With an existing draft, it
asks to append after a blank line or cancel; there is no overwrite option. If the
draft/conversation changes during a dialog, insertion is cancelled. An explicit
`send` sends plain text to this same chat without reading/submitting the editor
or expanding slash commands, and is refused while busy or messages are pending.
Shell/slash shortcuts and terminal-control characters are not accepted as
suggestions. No suggestion executes directly as a tool or shell command.

The widget is hidden while working and refreshed only after `agent_settled`, not
`agent_end` (which may precede retries/continuations). It shows no older fallback
when the latest reply has no suggestions, is unfinished, or has failed. A newer
user message also invalidates the previous reply's suggestions. Startup/reload,
resume/fork, and `/tree` derive state from the active branch only. The toggle is
a small `next-steps-settings-v1` custom entry, outside model context.

Nothing is added to print, JSON, or RPC prompts; the picker/widget are TUI-only.
Custom-message automatic wakes do not receive the suggestion instructions.
The extension does not create projects, sessions, jobs, or a second memory store.

## Load and test

The global extensions symlink discovers `index.ts` automatically. Run `/reload`
when idle to load both this extension and the new Ctrl+X prefix action. Suggestions
will start with the next answer; old replies are not regenerated retroactively.

From `~/.dotfiles/pi/.pi/agent/extensions`:

```sh
npm test
npm run typecheck
```

For a standalone/bundled Pi installation without importable SDK modules, set
`PI_TEST_HOST` to an npm installation of **the same version**, e.g. the
`node_modules/@earendil-works/pi-coding-agent` directory, for both commands.
Tests do not make paid provider calls. They cover parsing, streaming suppression,
branch restoration, draft safety, stale dialogs, explicit sends, prefix/click
behavior, lifecycle boundaries, narrow widths, and non-TUI modes.
