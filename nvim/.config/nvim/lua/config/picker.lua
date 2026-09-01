local function project_root()
  local cwd = vim.fn.getcwd()
  local result = vim.system({ "git", "-C", cwd, "rev-parse", "--show-toplevel" }, { text = true }):wait()
  if result.code == 0 then
    return vim.trim(result.stdout), true
  end
  return cwd, false
end

local function picker_window()
  local height = math.max(12, math.floor(vim.o.lines * 0.8))
  local width = math.max(40, math.floor(vim.o.columns * 0.8))
  height = math.min(height, vim.o.lines - 2)
  width = math.min(width, vim.o.columns - 2)
  return {
    anchor = "NW",
    height = height,
    width = width,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    border = "rounded",
  }
end

require("mini.pick").setup({ window = { config = picker_window } })
require("mini.extra").setup()

local M = {}

function M.files()
  local root, is_git = project_root()
  MiniPick.builtin.files({ tool = is_git and "git" or nil }, { source = { cwd = root } })
end

function M.grep()
  local root = project_root()
  MiniPick.builtin.grep_live({}, { source = { cwd = root } })
end

vim.api.nvim_create_user_command("WorkspaceFiles", M.files, { desc = "Find project files", force = true })

vim.keymap.set("n", "<C-p>", M.files, { silent = true, desc = "Find files" })
vim.keymap.set("n", "<leader>fg", M.grep, { silent = true, desc = "Live grep" })
vim.keymap.set("n", "<leader>fb", MiniPick.builtin.buffers, { silent = true, desc = "Buffers" })
vim.keymap.set("n", "<leader>fr", function()
  MiniExtra.pickers.oldfiles({ current_dir = true })
end, { silent = true, desc = "Recent files" })
vim.keymap.set("n", "<leader>fd", function()
  MiniExtra.pickers.diagnostic({ scope = "all" })
end, { silent = true, desc = "Diagnostics" })
vim.keymap.set("n", "<leader>fs", function()
  MiniExtra.pickers.lsp({ scope = "document_symbol" })
end, { silent = true, desc = "Document symbols" })
vim.keymap.set("n", "<leader>fS", function()
  MiniExtra.pickers.lsp({ scope = "workspace_symbol_live" })
end, { silent = true, desc = "Workspace symbols" })
vim.keymap.set("n", "<leader>gc", function()
  MiniExtra.pickers.git_commits({ path = "%" })
end, { silent = true, desc = "File history" })
vim.keymap.set("n", "<leader>gh", function()
  local path = vim.api.nvim_buf_get_name(0)
  MiniExtra.pickers.git_hunks({ path = path ~= "" and path or nil })
end, { silent = true, desc = "Changed hunks" })

return M
