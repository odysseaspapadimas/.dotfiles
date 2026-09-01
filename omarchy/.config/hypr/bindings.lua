-- Keep only your personal keybinding overrides here. Add new bindings or
-- unbind defaults before replacing them.

-- See current bindings and descriptions:
--   omarchy menu keybindings --print

-- To disable every Omarchy default binding, set this in
-- ~/.config/hypr/hyprland.lua before require("default.hypr.omarchy"), then add
-- only the bindings you want below:
--   omarchy_default_bindings = false

-- To disable all preinstalled app/webapp bindings, set:
--   omarchy_preinstalled_bindings = false

-- Add a new binding.
-- o.bind("SUPER + SHIFT + R", "SSH", "alacritty -e ssh your-server")

-- Change an existing binding by unbinding it first, then binding the key again.
-- This example changes SUPER+SPACE from the launcher to the Omarchy root menu.
-- hl.unbind("SUPER + SPACE")
-- o.bind("SUPER + SPACE", "Omarchy menu", "omarchy-menu toggle root")

-- Open the configured Omarchy Spotify player instead of Omarchy's stock
-- Music launcher (which offers to install the desktop Spotify package).
hl.unbind("SUPER + SHIFT + M")
o.bind("SUPER + SHIFT + M", "Omarchy Spotify", "omarchy shell -q quickshell.spotify.player togglePlayer")

-- Toggle between the dual-monitor and laptop-only hyprmoncfg profiles.
o.bind("SUPER + CTRL + ALT + M", "Toggle external monitor", "~/.local/bin/toggle-external-monitor")

-- Keep Omarchy's drop-down agent on SUPER+grave, while using a separate,
-- ordinary special workspace as the scratchpad on SUPER+S.
hl.unbind("SUPER + S")
o.bind("SUPER + S", "Toggle scratchpad", hl.dsp.workspace.toggle_special("normal-scratchpad"))
hl.unbind("SUPER + ALT + S")
o.bind("SUPER + ALT + S", "Move window to scratchpad", hl.dsp.window.move({ workspace = "special:normal-scratchpad", follow = false }))

-- Disable a default binding without replacing it.
-- hl.unbind("SUPER + SHIFT + B")

-- Logitech MX Keys examples:
-- o.bind("SUPER + SHIFT + S", nil, "omarchy-capture-screenshot")
o.bind("SUPER + H", "Toggle voice typing", "voxtype record toggle")
-- o.bind("SUPER + PERIOD", nil, "omarchy-shell shell toggle omarchy.emojis")
