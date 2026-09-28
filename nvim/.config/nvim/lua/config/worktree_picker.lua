-- Pick a Git checkout by branch; keep every checkout in the same Herdr workspace.
local M = {}

function M.list(root)
  local output = vim.system({ "git", "-C", root, "worktree", "list", "--porcelain" }, { text = true }):wait(5000)
  if output.code ~= 0 then return nil end
  local items = {}
  for block in (output.stdout .. "\n\n"):gmatch("(.-)\n\n") do
    local path = block:match("^worktree ([^\n]+)")
    if path and not block:find("\nprunable", 1, true) then
      local branch = block:match("\nbranch refs/heads/([^\n]+)") or "(detached)"
      items[#items + 1] = { branch = branch, path = path }
    end
  end
  return items
end

function M.open(shell)
  if vim.env.HERDR_ENV ~= "1" or not vim.env.HERDR_PANE_ID then
    vim.notify("Worktree navigation needs a Herdr-managed Neovim pane", vim.log.levels.ERROR)
    return
  end
  local items = M.list(vim.fn.getcwd())
  if not items or #items == 0 then
    vim.notify("No Git worktrees found for this checkout", vim.log.levels.WARN)
    return
  end
  vim.ui.select(items, {
    prompt = shell and "Open checkout shell" or "Open checkout editor",
    format_item = function(item) return item.branch .. "  ·  " .. item.path end,
  }, function(item)
    if not item then return end
    local argv = { "workspace-editor", "--checkout", item.path }
    if shell then argv[#argv + 1] = "--shell" end
    vim.system(argv, { text = true }, function(result)
      if result.code == 0 then return end
      vim.schedule(function()
        vim.notify("Checkout not opened: " .. vim.trim(result.stderr or "unknown error"), vim.log.levels.ERROR)
      end)
    end)
  end)
end

function M.setup()
  vim.api.nvim_create_user_command("WorkspaceWorktrees", function() M.open(false) end, { desc = "Open a checkout editor by branch", force = true })
  vim.api.nvim_create_user_command("WorkspaceWorktreeShell", function() M.open(true) end, { desc = "Open a checkout shell for an agent", force = true })
  vim.keymap.set("n", "<leader>gw", function() M.open(false) end, { silent = true, desc = "Open worktree editor" })
  vim.keymap.set("n", "<leader>gW", function() M.open(true) end, { silent = true, desc = "Open worktree agent shell" })
end

return M
