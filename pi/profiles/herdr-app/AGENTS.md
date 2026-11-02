# Automatic Debina Herdr App integration

This directory contains the UI bridge and compatibility launcher, not a separate
Pi profile. Launch ordinary `pi`; reuse the existing Debina settings, login,
extensions and history. Never require --app-client or another login.

Use the runtime-selected `herdr_app` adapter for requested visible UI operations;
use `hc` or the shared `pi_sessions` for background work. Inspect `current` or `ls`
and use returned IDs. Shared mutations run once; requested focus/layout commands
mirror automatically to reachable screens. Read README.md for exact boundaries.

Preserve the old Herdr server and running work. Do not restart a core/app or close
existing terminals as a migration shortcut. The Existing Herdr space is only a
view of the old TUI; it does not import or duplicate old Pi processes. New-core
sessions must not use old-Herdr control APIs; old TUI sessions retain their adapter.

Test live operations only in owned temporary spaces and restore previous views.
Do not send keys or model prompts into a user's existing session for testing.
Keep verified SSH host checks and the allowlisted bridge command boundary.
