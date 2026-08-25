local clue = require("mini.clue")
local gen_clues = clue.gen_clues

clue.setup({
  triggers = {
    { mode = "n", keys = "<Leader>" },
    { mode = "x", keys = "<Leader>" },
    { mode = "n", keys = "[" },
    { mode = "n", keys = "]" },
    { mode = "n", keys = "g" },
    { mode = "n", keys = "z" },
    { mode = "n", keys = "<C-w>" },
    { mode = "n", keys = "'" },
    { mode = "n", keys = "`" },
    { mode = "n", keys = '"' },
    { mode = "x", keys = '"' },
    { mode = "i", keys = "<C-x>" },
  },
  clues = {
    { mode = "n", keys = "<Leader>b", desc = "+Buffers" },
    { mode = "n", keys = "<Leader>f", desc = "+Find" },
    { mode = "n", keys = "<Leader>g", desc = "+Git" },
    { mode = "n", keys = "<Leader>h", desc = "+Git hunks" },
    { mode = "x", keys = "<Leader>h", desc = "+Git hunks" },
    { mode = "n", keys = "<Leader>q", desc = "+Quickfix" },
    gen_clues.builtin_completion(),
    gen_clues.g(),
    gen_clues.marks(),
    gen_clues.registers(),
    gen_clues.windows(),
    gen_clues.z(),
  },
  window = {
    delay = 300,
    config = { border = "rounded" },
  },
})
