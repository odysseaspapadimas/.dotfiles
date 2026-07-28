local group = vim.api.nvim_create_augroup("external-file-changes", { clear = true })
local interval = 750
local stopped = false

local function check_buffer(buffer)
  if not vim.api.nvim_buf_is_valid(buffer)
    or not vim.api.nvim_buf_is_loaded(buffer)
    or vim.bo[buffer].buftype ~= ""
    or vim.bo[buffer].modified
    or vim.api.nvim_buf_get_name(buffer) == ""
  then
    return
  end

  vim.cmd("silent! checktime " .. buffer)
end

local function check_visible_buffers()
  local checked = {}
  for _, window in ipairs(vim.api.nvim_list_wins()) do
    local buffer = vim.api.nvim_win_get_buf(window)
    if not checked[buffer] then
      checked[buffer] = true
      check_buffer(buffer)
    end
  end
end

local function poll()
  if stopped then
    return
  end
  check_visible_buffers()
  vim.defer_fn(poll, interval)
end

vim.api.nvim_create_autocmd({ "FocusGained", "CursorHold", "CursorHoldI" }, {
  group = group,
  callback = check_visible_buffers,
})

vim.api.nvim_create_autocmd("VimEnter", {
  group = group,
  once = true,
  callback = poll,
})

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = group,
  callback = function()
    stopped = true
  end,
})
