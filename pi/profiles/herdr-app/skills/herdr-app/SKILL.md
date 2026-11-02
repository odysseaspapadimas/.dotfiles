---
name: herdr-app
description: Manage visible tabs, splits, focus and layouts in the new Herdr App using the shared Debina core. Windows and Omarchy are screens onto the same agents; no desktop or Pi profile selection is needed.
---

# Herdr App

Use ordinary `pi` on Debina with its existing configuration/login/history.
Inside a new-core terminal, use the `herdr_app` tool. Start with `current` to find
the calling terminal's space/tab/pane, or `ls` to inspect shared Debina topology.
`commands` lists native commands; `do` executes one with explicit returned IDs.

No client selection is needed. Shared structure is changed once. Requested focus
and layout operations are mirrored automatically to connected desktop windows.
Offline screens are reported, not launched. A partial view failure does not mean
creation failed: inspect the returned result before retrying anything.

Use `hc` or shared `pi_sessions` for programs/background agents. Launch child Pi
with `pi`, never an isolated profile. Do not use the old herdr CLI from new-core
sessions. Old TUI sessions retain their old adapter and remain reachable through
the Existing Herdr compatibility view without importing or duplicating processes.

Only create visible tabs/splits when requested. Never close existing work, restart
an app/core, or kill processes to make a test pass. Close/kill needs explicit IDs
and allow_destructive only after user authorization or for your own test cleanup.
