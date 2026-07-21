# Herdr side chat

`/side` creates or focuses an ephemeral Pi conversation in a split Herdr pane. The side chat inherits a snapshot of the main session's context without adding its exploratory turns to the main conversation.

## Commands

| Command | Purpose |
| --- | --- |
| `/side` | Create/focus the side chat, or return to the main pane when run inside the side chat. |
| `/side:new` | Discard the current side pane and start with a fresh main-session snapshot. |
| `/side:status` | Open the management menu with snapshot age, context lag, local-turn count, handoff, save, refresh, and close actions. |
| `/side:refresh` | Refresh inherited context while preserving local work, starting fresh, or summarizing local work first. |
| `/side:inject` | Choose summarized, guided, or full handoff to the main session. |
| `/side:inject summary` | Send a concise handoff to the main session. |
| `/side:inject guided` | Request a summary with custom emphasis. |
| `/side:inject raw` | Send the full local transcript to the main session. |
| `/side:save` | Save the ephemeral conversation as a normal Pi session. |
| `/side:close` | Close safely; unhanded local work offers summarize, save, discard, or cancel. |

The side status reports whether inherited context is current, how many main turns it trails, local conversation size, and whether the latest local work has been handed off. Duplicate handoffs are blocked until another local turn is added.

## Ctrl+X shortcuts

- `Ctrl+X b` — create/focus side chat
- `Ctrl+X j` — summarized handoff
- `Ctrl+X J` — full handoff

These shortcuts preserve the current editor draft.
