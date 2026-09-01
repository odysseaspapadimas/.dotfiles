-- Change the default Omarchy look'n'feel.

-- https://wiki.hypr.land/Configuring/Basics/Variables/#general
-- hl.config({
--   general = {
--     -- No gaps between windows or borders.
--     gaps_in = 0,
--     gaps_out = 0,
--     border_size = 0,
--
--     -- Change to niri-like side-scrolling layout.
--     layout = "scrolling",
--   },
-- })

-- Make the focused window stand out with a thicker, brighter border.
local active_border_color = "rgba(cba6f7ff)"

hl.config({
  general = {
    border_size = 4,
    col = {
      active_border = active_border_color,
      inactive_border = "rgba(59595966)",
    },
  },

  decoration = {
    rounding = 8,
    shadow = {
      enabled = true,
      range = 12,
      render_power = 3,
      color = "rgba(cba6f788)",
      color_inactive = "rgba(00000000)",
    },
  },

  group = {
    col = {
      border_active = active_border_color,
      border_inactive = "rgba(59595966)",
      border_locked_active = active_border_color,
      border_locked_inactive = "rgba(59595966)",
    },
  },
})

-- https://wiki.hypr.land/Configuring/Basics/Variables/#animations
-- hl.config({
--   animations = {
--     -- Disable all animations.
--     enabled = false,
--   },
-- })

-- https://wiki.hypr.land/Configuring/Basics/Variables/#layout
-- hl.config({
--   layout = {
--     -- Avoid overly wide single-window layouts on wide screens.
--     single_window_aspect_ratio = { 1, 1 },
--   },
-- })

-- https://wiki.hypr.land/Configuring/Layouts/Scrolling-Layout/
-- hl.config({
--   scrolling = {
--     -- See only one column per screen instead of two.
--     column_width = 0.97,
--   },
-- })
