-- Show the preview URL as a fallback when no graphical browser can be opened.
vim.g.mkdp_echo_preview_url = 1

local specs = {
  { src = "https://github.com/catppuccin/nvim", name = "catppuccin" },
  { src = "https://github.com/nvim-mini/mini.nvim", version = "stable" },
  { src = "https://github.com/nvim-lua/plenary.nvim" },
  { src = "https://github.com/MunifTanjim/nui.nvim" },
  { src = "https://github.com/nvim-neo-tree/neo-tree.nvim", version = "v3.x" },
  { src = "https://github.com/lewis6991/gitsigns.nvim" },
  { src = "https://github.com/lewis6991/satellite.nvim" },
  { src = "https://github.com/nvim-treesitter/nvim-treesitter" },
  { src = "https://github.com/neovim/nvim-lspconfig" },
  { src = "https://github.com/mason-org/mason.nvim" },
  { src = "https://github.com/mason-org/mason-lspconfig.nvim" },
  { src = "https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim" },
  {
    src = "https://github.com/Saghen/blink.cmp",
    version = vim.version.range("1"),
  },
  { src = "https://github.com/stevearc/conform.nvim" },
  { src = "https://github.com/iamcco/markdown-preview.nvim" },
}

vim.pack.add(specs)
