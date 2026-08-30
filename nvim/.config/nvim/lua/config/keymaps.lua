local function map(mode, lhs, rhs, description)
  vim.keymap.set(mode, lhs, rhs, { silent = true, desc = description })
end

local function smart_close_buffer()
  local current = vim.api.nvim_get_current_buf()
  local listed = vim.tbl_filter(function(buffer)
    return vim.bo[buffer].buflisted
  end, vim.api.nvim_list_bufs())
  if #listed <= 1 then
    vim.cmd.enew()
  else
    vim.cmd.bprevious()
  end
  if vim.api.nvim_buf_is_valid(current) and vim.bo[current].buflisted then
    vim.api.nvim_buf_delete(current, { force = false })
  end
end

map("n", "<leader>e", "<cmd>Neotree filesystem toggle<CR>", "File tree")
map("n", "<leader>gs", function()
  require("config.workspace_git").open_status()
end, "Git status")
map("n", "<leader>bd", smart_close_buffer, "Close buffer")
map("n", "<leader>uw", "<cmd>set wrap!<CR>", "Toggle line wrap")
map("n", "[b", "<cmd>bprevious<CR>", "Previous buffer")
map("n", "]b", "<cmd>bnext<CR>", "Next buffer")
map("n", "[q", "<cmd>cprevious<CR>", "Previous quickfix item")
map("n", "]q", "<cmd>cnext<CR>", "Next quickfix item")
map("n", "<leader>qo", "<cmd>copen<CR>", "Open quickfix")
map("n", "<leader>qc", "<cmd>cclose<CR>", "Close quickfix")
map("n", "<C-h>", "<C-w>h", "Window left")
map("n", "<C-j>", "<C-w>j", "Window down")
map("n", "<C-k>", "<C-w>k", "Window up")
map("n", "<C-l>", "<C-w>l", "Window right")
map("n", "<A-j>", "<cmd>move .+1<CR>==", "Move line down")
map("n", "<A-k>", "<cmd>move .-2<CR>==", "Move line up")
map("x", "<A-j>", ":move '>+1<CR>gv=gv", "Move selection down")
map("x", "<A-k>", ":move '<-2<CR>gv=gv", "Move selection up")
map("n", "<Esc>", "<cmd>nohlsearch<CR>", "Clear search highlight")
