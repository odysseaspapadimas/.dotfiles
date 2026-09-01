-- Learn how to configure Hyprland: https://wiki.hypr.land/Configuring/Start/

-- Omarchy's bootstrap keeps path setup out of this user config.
dofile((os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/default/hypr/bootstrap.lua")

-- Disable all Omarchy default bindings. Add your own in hypr/bindings.lua.
-- omarchy_default_bindings = false
--
-- Or disable only bindings for Omarchy's preinstalled apps/web apps while
-- keeping core window-manager bindings:
-- omarchy_preinstalled_bindings = false

-- Load Omarchy defaults.
require("default.hypr.omarchy")

-- Put your personal overrides in these files. They're loaded after Omarchy's
-- defaults so package updates can improve the defaults without rewriting your
-- ~/.config/hypr files.
require("hypr.monitors")
require("hypr.input")
require("hypr.bindings")
require("hypr.looknfeel")
require("hypr.autostart")

-- Toggle config flags dynamically.
require("default.hypr.toggles")

-- Prefer user compatibility shims over package-managed binaries. This lets
-- the Omarchy agent collector use ~/.local/bin/codex with newer Codex CLIs.
local user_bin = (os.getenv("HOME") or "") .. "/.local/bin"
local path_entries = { user_bin }
for entry in (os.getenv("PATH") or "/usr/local/bin:/usr/bin"):gmatch("[^:]+") do
  if entry ~= user_bin then table.insert(path_entries, entry) end
end
hl.env("PATH", table.concat(path_entries, ":"))

-- Present the Quickshell Spotify full player as a centered overlay rather than
-- inserting it into the tiled layout.
o.window({ class = "^org.quickshell$", title = "^Omarchy Spotify$" }, {
  float = true,
  center = true,
  size = { 1200, 820 },
})

-- Add any other personal Hyprland configuration below.
-- o.window("qemu", { workspace = "5" })

-- Added by hyprmoncfg: its generated monitor rules load last, so nothing before this can override the applied layout.
dofile(os.getenv("HOME") .. "/.config/hypr/hyprmoncfg-monitors.lua")
