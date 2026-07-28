local opt = vim.opt

opt.number = true
opt.relativenumber = true
opt.cursorline = true
opt.signcolumn = "yes"
opt.wrap = false
opt.termguicolors = true
opt.mouse = "a"
opt.clipboard = "unnamedplus"
opt.ignorecase = true
opt.smartcase = true
opt.scrolloff = 4
opt.sidescrolloff = 4
opt.foldenable = false
opt.splitbelow = true
opt.splitright = true
opt.confirm = true
opt.autoread = true
opt.undofile = true
opt.swapfile = true
opt.backup = false
opt.writebackup = true
opt.updatetime = 250
opt.timeoutlen = 400
opt.completeopt = { "menu", "menuone", "noselect" }
opt.expandtab = true
opt.shiftwidth = 2
opt.softtabstop = 2
opt.tabstop = 2
opt.smartindent = true

vim.cmd("syntax enable")
vim.cmd("filetype plugin indent on")
