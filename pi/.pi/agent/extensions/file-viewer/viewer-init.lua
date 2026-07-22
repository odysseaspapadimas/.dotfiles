-- Minimal, deterministic read-only viewer configuration.
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.cursorline = true
vim.opt.signcolumn = "no"
vim.opt.wrap = false
vim.opt.termguicolors = true
vim.opt.list = false
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.writebackup = false
vim.opt.undofile = false
vim.opt.mouse = "a"
vim.opt.scrolloff = 4
vim.opt.sidescrolloff = 4
vim.opt.foldenable = false

local plugin_root = vim.fn.expand("~/.local/share/pi-file-viewer")
vim.opt.runtimepath:prepend(plugin_root .. "/plenary.nvim")
vim.opt.runtimepath:prepend(plugin_root .. "/nui.nvim")
vim.opt.runtimepath:prepend(plugin_root .. "/neo-tree.nvim")
vim.opt.runtimepath:prepend(plugin_root .. "/mini.nvim")

require("mini.icons").setup()
MiniIcons.mock_nvim_web_devicons()
require("neo-tree").setup({
  filesystem = { follow_current_file = { enabled = true } },
  window = { width = 36 },
})

local function picker_window()
  local height = math.max(12, math.floor(vim.o.lines * 0.8))
  local width = math.max(40, math.floor(vim.o.columns * 0.8))
  return {
    anchor = "NW",
    height = math.min(height, vim.o.lines - 2),
    width = math.min(width, vim.o.columns - 2),
    row = math.floor((vim.o.lines - math.min(height, vim.o.lines - 2)) / 2),
    col = math.floor((vim.o.columns - math.min(width, vim.o.columns - 2)) / 2),
    border = "rounded",
  }
end
require("mini.pick").setup({ window = { config = picker_window } })

vim.g.mapleader = " "
vim.g.maplocalleader = " "
local function map(mode, lhs, rhs, description)
  vim.keymap.set(mode, lhs, rhs, { silent = true, desc = description })
end

local function smart_close_buffer()
  local listed = vim.tbl_filter(function(buffer)
    return vim.bo[buffer].buflisted
  end, vim.api.nvim_list_bufs())
  if #listed <= 1 then
    vim.cmd("enew")
    vim.cmd("bdelete #")
  else
    vim.cmd("bprevious")
    vim.cmd("bdelete #")
  end
end

map("n", "<leader>e", "<cmd>Neotree toggle<CR>", "Neo-tree")
map("n", "<C-p>", function() MiniPick.builtin.files() end, "Find files")
map("n", "<leader>fg", function() MiniPick.builtin.grep_live() end, "Live grep")
map("n", "<leader>fb", function() MiniPick.builtin.buffers() end, "Buffers")
map("n", "<leader>bd", smart_close_buffer, "Close buffer")
map("n", "[b", "<cmd>bprevious<CR>", "Previous buffer")
map("n", "]b", "<cmd>bnext<CR>", "Next buffer")
map("n", "<A-j>", "<cmd>m .+1<CR>==", "Move line down")
map("n", "<A-k>", "<cmd>m .-2<CR>==", "Move line up")
map("x", "<A-j>", ":m '>+1<CR>gv=gv", "Move selection down")
map("x", "<A-k>", ":m '<-2<CR>gv=gv", "Move selection up")

vim.cmd("syntax enable")
vim.cmd("filetype plugin indent on")

local c = {
  base = "#1e1e2e", mantle = "#181825", surface0 = "#313244",
  surface1 = "#45475a", overlay0 = "#6c7086", text = "#cdd6f4",
  subtext0 = "#a6adc8", mauve = "#cba6f7", blue = "#89b4fa",
  sapphire = "#74c7ec", green = "#a6e3a1", yellow = "#f9e2af",
  peach = "#fab387", red = "#f38ba8", pink = "#f5c2e7",
}

local function hi(group, values)
  vim.api.nvim_set_hl(0, group, values)
end

hi("Normal", { fg = c.text, bg = c.base })
hi("NormalNC", { fg = c.text, bg = c.base })
hi("EndOfBuffer", { fg = c.base, bg = c.base })
hi("LineNr", { fg = c.overlay0, bg = c.base })
hi("LineNrAbove", { fg = c.surface1, bg = c.base })
hi("LineNrBelow", { fg = c.surface1, bg = c.base })
hi("CursorLine", { bg = c.mantle })
hi("CursorLineNr", { fg = c.mauve, bg = c.mantle, bold = true })
hi("Visual", { bg = c.surface1 })
hi("Search", { fg = c.base, bg = c.yellow })
hi("IncSearch", { fg = c.base, bg = c.peach })
hi("StatusLine", { fg = c.text, bg = c.surface0 })
hi("StatusLineNC", { fg = c.subtext0, bg = c.mantle })
hi("VertSplit", { fg = c.surface0, bg = c.base })
hi("WinSeparator", { fg = c.surface0, bg = c.base })
hi("Pmenu", { fg = c.text, bg = c.surface0 })
hi("PmenuSel", { fg = c.base, bg = c.mauve })
hi("MiniPickBorder", { fg = c.mauve, bg = c.base })
hi("MiniPickBorderBusy", { fg = c.peach, bg = c.base })
hi("MiniPickBorderText", { fg = c.mauve, bg = c.base, bold = true })
hi("MiniPickHeader", { fg = c.blue, bg = c.base })
hi("MiniPickMatchCurrent", { bg = c.surface0 })
hi("MiniPickMatchMarked", { fg = c.green, bg = c.surface0 })
hi("MiniPickMatchRanges", { fg = c.mauve, bold = true })
hi("MiniPickNormal", { fg = c.text, bg = c.base })
hi("MiniPickPreviewLine", { bg = c.mantle })
hi("MiniPickPreviewRegion", { bg = c.surface1 })
hi("MiniPickPrompt", { fg = c.sapphire, bg = c.base })
hi("Comment", { fg = c.overlay0, italic = true })
hi("Constant", { fg = c.peach })
hi("String", { fg = c.green })
hi("Character", { fg = c.green })
hi("Number", { fg = c.peach })
hi("Boolean", { fg = c.peach })
hi("Identifier", { fg = c.text })
hi("Function", { fg = c.blue })
hi("Statement", { fg = c.mauve })
hi("Keyword", { fg = c.mauve, italic = true })
hi("Operator", { fg = c.sapphire })
hi("PreProc", { fg = c.pink })
hi("Type", { fg = c.yellow })
hi("Special", { fg = c.pink })
hi("Error", { fg = c.red, bold = true })
hi("Todo", { fg = c.base, bg = c.yellow, bold = true })

