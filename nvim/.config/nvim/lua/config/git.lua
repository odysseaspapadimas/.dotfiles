require("gitsigns").setup({
  current_line_blame = false,
  signs_staged_enable = true,
  on_attach = function(buffer)
    local gitsigns = require("gitsigns")
    local function map(mode, lhs, rhs, description)
      vim.keymap.set(mode, lhs, rhs, { buffer = buffer, silent = true, desc = description })
    end

    map("n", "]c", function()
      if vim.wo.diff then
        vim.cmd.normal({ "]c", bang = true })
      else
        gitsigns.nav_hunk("next")
      end
    end, "Next Git hunk")
    map("n", "[c", function()
      if vim.wo.diff then
        vim.cmd.normal({ "[c", bang = true })
      else
        gitsigns.nav_hunk("prev")
      end
    end, "Previous Git hunk")
    map("n", "<leader>hs", gitsigns.stage_hunk, "Stage hunk")
    map("n", "<leader>hr", gitsigns.reset_hunk, "Reset hunk")
    map("v", "<leader>hs", function()
      gitsigns.stage_hunk({ vim.fn.line("."), vim.fn.line("v") })
    end, "Stage selected hunk")
    map("v", "<leader>hr", function()
      gitsigns.reset_hunk({ vim.fn.line("."), vim.fn.line("v") })
    end, "Reset selected hunk")
    map("n", "<leader>hS", gitsigns.stage_buffer, "Stage buffer")
    map("n", "<leader>hu", gitsigns.undo_stage_hunk, "Undo staged hunk")
    map("n", "<leader>hR", gitsigns.reset_buffer, "Reset buffer")
    map("n", "<leader>hp", gitsigns.preview_hunk, "Preview hunk")
    map("n", "<leader>hb", function()
      gitsigns.blame_line({ full = true })
    end, "Blame line")
    map("n", "<leader>hB", gitsigns.toggle_current_line_blame, "Toggle line blame")
    map("n", "<leader>hd", gitsigns.diffthis, "Diff against index")
    map("n", "<leader>hD", function()
      gitsigns.diffthis("~")
    end, "Diff against previous commit")
    map({ "o", "x" }, "ih", ":<C-U>Gitsigns select_hunk<CR>", "Git hunk")
  end,
})

require("satellite").setup({
  current_only = false,
  winblend = 20,
  excluded_filetypes = {
    "neo-tree",
    "minipick",
    "lazy",
    "mason",
    "help",
  },
  handlers = {
    cursor = { enable = true },
    diagnostic = { enable = false },
    search = { enable = false },
    marks = { enable = false },
    quickfix = { enable = false },
    gitsigns = {
      enable = true,
      overlap = true,
      signs = {
        add = "│",
        change = "│",
        delete = "─",
      },
    },
  },
})
