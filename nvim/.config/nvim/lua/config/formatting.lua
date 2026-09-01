local conform = require("conform")

conform.setup({
  formatters_by_ft = {
    css = { "prettier" },
    html = { "prettier" },
    javascript = { "prettier" },
    javascriptreact = { "prettier" },
    json = { "prettier" },
    jsonc = { "prettier" },
    markdown = { "prettier" },
    php = { "pint", "php_cs_fixer", stop_after_first = true, lsp_format = "fallback" },
    rust = { "rustfmt", lsp_format = "fallback" },
    typescript = { "prettier" },
    typescriptreact = { "prettier" },
  },
  formatters = {
    php_cs_fixer = {
      args = function(_, context)
        local config = vim.fs.find(
          { ".php-cs-fixer.php", ".php-cs-fixer.dist.php" },
          { path = context.dirname, upward = true }
        )
        if #config > 0 then
          return { "fix", "--no-interaction", "$FILENAME" }
        end
        return {
          "fix",
          "--no-interaction",
          "--rules=@PER-CS",
          "--using-cache=no",
          "$FILENAME",
        }
      end,
    },
  },
  format_on_save = function(buffer)
    if vim.g.disable_autoformat or vim.b[buffer].disable_autoformat then
      return
    end
    return { timeout_ms = 1000, lsp_format = "fallback" }
  end,
  default_format_opts = { lsp_format = "fallback" },
})

vim.api.nvim_create_user_command("FormatToggle", function(args)
  if args.bang then
    vim.g.disable_autoformat = not vim.g.disable_autoformat
    vim.notify("Format on save " .. (vim.g.disable_autoformat and "disabled globally" or "enabled globally"))
  else
    vim.b.disable_autoformat = not vim.b.disable_autoformat
    vim.notify("Format on save " .. (vim.b.disable_autoformat and "disabled for buffer" or "enabled for buffer"))
  end
end, {
  bang = true,
  desc = "Toggle format on save for buffer; use ! for global",
  force = true,
})

vim.keymap.set({ "n", "x" }, "<leader>cf", function()
  conform.format({ async = true, lsp_format = "fallback" })
end, { silent = true, desc = "Format buffer or selection" })
