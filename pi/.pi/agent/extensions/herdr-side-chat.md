# Herdr side chat

`/side` creates or focuses a separate ephemeral Pi assistant in a split Herdr pane. It is intended for focused tangents, questions, reviews, and parallel tasks without automatically continuing the main chat. The side chat inherits a snapshot of the main session as provenance-labeled background reference; historical instructions are not treated as active side-chat requests, and work from the main assistant is not attributed to the side assistant. Its exploratory turns are not added to the main conversation.

Use `/side <task>` to open the side chat and immediately give it a clear assignment. Herdr's live-agent facade starts the side Pi and submits prompts and management commands atomically, so they are only delivered at a detected agent prompt.

## Commands

| Command | Purpose |
| --- | --- |
| `/side [task]` | Create/focus the side chat and optionally send its task; return to the main pane when run inside the side chat. |
| `/side:new` | Discard the current side pane and start with a fresh main-session snapshot. |
| `/side:status` | Open the management menu with snapshot age, context lag, local-turn count, handoff, save, refresh, and close actions. |
| `/side:refresh` | Refresh inherited context while preserving local work, starting fresh, or summarizing local work first. |
| `/side:inject` | Choose summarized, guided, or full handoff to the main session. |
| `/side:inject summary` | Send a concise handoff to the main session. |
| `/side:inject guided` | Request a summary with custom emphasis. |
| `/side:inject raw` | Send the full local transcript to the main session. |
| `/side:save` | Save the ephemeral conversation as a normal Pi session. |
| `/side:close` | Close safely; unhanded local work offers summarize, save, discard, or cancel. |

The footer stays clear while the side chat has no unsent work. It shows only `side · unsent` after local work is added and clears again after handoff. Snapshot age, approximate main-prompt lag, local conversation size, and handoff details remain available through `/side:status`. Duplicate handoffs are blocked until another local turn is added.

Side chats share the main Pi session store, so `pi_sessions` can discover and create normal sessions even though the side conversation itself remains ephemeral. Within a side chat, `main` and `parent` resolve to its source session.

## Ctrl+X shortcuts

- `Ctrl+X b` — create/focus side chat; when the main editor has a draft, send that draft as the side task while preserving it in the main editor
- `Ctrl+X j` — summarized handoff
- `Ctrl+X J` — full handoff

These shortcuts preserve the current editor draft.
