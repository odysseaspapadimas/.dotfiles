local parsers = {
  "bash",
  "css",
  "html",
  "javascript",
  "json",
  "markdown",
  "markdown_inline",
  "php",
  "php_only",
  "rust",
  "tsx",
  "typescript",
  "vim",
  "vimdoc",
}

local filetypes = {
  "bash",
  "css",
  "html",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
  "markdown",
  "php",
  "rust",
  "typescript",
  "typescriptreact",
  "vim",
  "vimdoc",
}

local function install_parsers()
  if vim.fn.executable("tree-sitter") ~= 1 then
    return
  end
  require("nvim-treesitter").install(parsers)
end

vim.api.nvim_create_autocmd("FileType", {
  pattern = filetypes,
  callback = function(event)
    pcall(vim.treesitter.start, event.buf)
  end,
})

vim.api.nvim_create_autocmd("User", {
  pattern = "MasonToolsUpdateCompleted",
  callback = function()
    vim.schedule(install_parsers)
  end,
})

vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(event)
    local data = event.data or {}
    if data.spec and data.spec.name == "nvim-treesitter" and data.kind == "update" then
      vim.schedule(function()
        if vim.fn.executable("tree-sitter") == 1 then
          vim.cmd("TSUpdate")
        end
      end)
    end
  end,
})

vim.schedule(install_parsers)
