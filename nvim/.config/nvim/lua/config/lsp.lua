require("mason").setup()

local servers = {
  "cssls",
  "eslint",
  "intelephense",
  "jsonls",
  "rust_analyzer",
  "ts_ls",
}

require("mason-lspconfig").setup({
  ensure_installed = servers,
  automatic_enable = servers,
})

require("mason-tool-installer").setup({
  ensure_installed = {
    "css-lsp",
    "eslint-lsp",
    "intelephense",
    "json-lsp",
    "php-cs-fixer",
    "prettier",
    "rust-analyzer",
    "tree-sitter-cli",
    "typescript-language-server",
  },
  auto_update = false,
  run_on_start = #vim.api.nvim_list_uis() > 0,
  start_delay = 3000,
  debounce_hours = 24,
})

local blink = require("blink.cmp")
blink.setup({
  keymap = { preset = "default" },
  completion = {
    documentation = { auto_show = true, auto_show_delay_ms = 300 },
    ghost_text = { enabled = false },
  },
  signature = { enabled = true },
  sources = { default = { "lsp", "path", "snippets", "buffer" } },
  fuzzy = { implementation = "lua" },
})

local capabilities = blink.get_lsp_capabilities()
for _, server in ipairs(servers) do
  vim.lsp.config(server, { capabilities = capabilities })
end
vim.lsp.enable(servers)

vim.diagnostic.config({
  severity_sort = true,
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "󰅚",
      [vim.diagnostic.severity.WARN] = "󰀪",
      [vim.diagnostic.severity.INFO] = "󰋽",
      [vim.diagnostic.severity.HINT] = "󰌶",
    },
  },
  underline = true,
  update_in_insert = false,
  virtual_text = false,
  virtual_lines = { current_line = true },
  float = { border = "rounded", source = true },
})

local function map(mode, lhs, rhs, description)
  vim.keymap.set(mode, lhs, rhs, { silent = true, desc = description })
end

map("n", "]d", function()
  vim.diagnostic.jump({ count = 1, float = true })
end, "Next diagnostic")
map("n", "[d", function()
  vim.diagnostic.jump({ count = -1, float = true })
end, "Previous diagnostic")
map("n", "<leader>de", vim.diagnostic.open_float, "Line diagnostics")
map("n", "<leader>dq", vim.diagnostic.setloclist, "Diagnostics to location list")

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(event)
    local function buffer_map(mode, lhs, rhs, description)
      vim.keymap.set(mode, lhs, rhs, {
        buffer = event.buf,
        silent = true,
        desc = description,
      })
    end

    buffer_map("n", "gd", function()
      MiniExtra.pickers.lsp({ scope = "definition" })
    end, "Go to definition")
    buffer_map("n", "gr", function()
      MiniExtra.pickers.lsp({ scope = "references" })
    end, "References")
    buffer_map("n", "gI", function()
      MiniExtra.pickers.lsp({ scope = "implementation" })
    end, "Implementations")
    buffer_map("n", "<leader>ca", vim.lsp.buf.code_action, "Code action")
    buffer_map("n", "<leader>rn", vim.lsp.buf.rename, "Rename symbol")
    buffer_map("n", "<leader>lh", function()
      vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({ bufnr = event.buf }), { bufnr = event.buf })
    end, "Toggle inlay hints")
  end,
})
