if vim.env.NVIM_WORKSPACE_EDITOR ~= "1" then
  return
end

local root = vim.fs.normalize(vim.fn.getcwd())
local session_directory = vim.env.NVIM_WORKSPACE_SESSION_DIR
  or (vim.fn.stdpath("data") .. "/workspace-sessions")
vim.fn.mkdir(session_directory, "p")

local root_name = vim.fs.basename(root):gsub("[^%w._-]", "-")
local session_name = string.format("%s-%s.vim", root_name, vim.fn.sha256(root):sub(1, 12))

vim.opt.sessionoptions = {
  "blank",
  "buffers",
  "curdir",
  "folds",
  "help",
  "localoptions",
  "tabpages",
  "winsize",
}

require("mini.sessions").setup({
  autoread = false,
  autowrite = true,
  directory = session_directory,
  file = "",
  verbose = { read = false, write = false, delete = true },
})

local function restore_requested_files(requested, cursor_line)
  if #requested == 0 then
    return
  end
  vim.cmd.edit(vim.fn.fnameescape(requested[1]))
  for index = 2, #requested do
    vim.cmd.badd(vim.fn.fnameescape(requested[index]))
  end
  if cursor_line then
    pcall(vim.api.nvim_win_set_cursor, 0, { cursor_line, 0 })
  end
end

local sessions_group = vim.api.nvim_create_augroup("config-sessions", { clear = true })
vim.api.nvim_create_autocmd("VimEnter", {
  group = sessions_group,
  once = true,
  callback = function()
    local requested = vim.fn.argv()
    local cursor_line = #requested == 1 and vim.api.nvim_win_get_cursor(0)[1] or nil
    if vim.env.NVIM_WORKSPACE_TARGET and vim.env.NVIM_WORKSPACE_TARGET ~= "" then
      requested = { vim.env.NVIM_WORKSPACE_TARGET }
      cursor_line = tonumber(vim.env.NVIM_WORKSPACE_LINE) or 1
    end
    if MiniSessions.detected[session_name] then
      MiniSessions.read(session_name)
      restore_requested_files(requested, cursor_line)
      return
    end

    restore_requested_files(requested, cursor_line)
    if #requested == 0 then
      vim.cmd("Neotree filesystem show")
    end
    MiniSessions.write(session_name, { verbose = false })
  end,
})

vim.api.nvim_create_user_command("WorkspaceSessionSave", function()
  MiniSessions.write(session_name, { verbose = true })
end, { desc = "Save the current workspace session", force = true })
