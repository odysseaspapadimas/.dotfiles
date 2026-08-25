if vim.fn.has("nvim-0.12") ~= 1 then
  error("This configuration requires Neovim 0.12 or newer")
end

vim.g.mapleader = " "
vim.g.maplocalleader = " "

require("config.options")
require("config.external_changes")
require("config.packages")
require("config.ui")
require("config.clue")
require("config.picker")
require("config.workspace_git").setup()
require("config.git")
require("config.treesitter")
require("config.lsp")
require("config.formatting")
require("config.sessions")
require("config.keymaps")
