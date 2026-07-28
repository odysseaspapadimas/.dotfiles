local M = {}

local MAX_ENTRIES = 1000
local MAX_REPOSITORIES = 32
local root = vim.fs.normalize(vim.fn.getcwd())
local repositories
local picker_namespace = vim.api.nvim_create_namespace("workspace_git_picker")

local function exact_git_root(path)
  local result = vim.system(
    { "git", "-C", path, "rev-parse", "--show-toplevel" },
    { text = true }
  ):wait(2000)
  if result.code ~= 0 then
    return nil
  end
  local resolved = vim.uv.fs_realpath(vim.trim(result.stdout))
  return resolved == vim.uv.fs_realpath(path) and resolved or nil
end

local function has_git_marker(path)
  local marker = vim.uv.fs_lstat(vim.fs.joinpath(path, ".git"))
  return marker and (marker.type == "directory" or marker.type == "file")
end

local function discover_repositories()
  local found = {}
  local seen = {}
  local function add(path)
    local repo = exact_git_root(path)
    if repo and not seen[repo] and #found < MAX_REPOSITORIES then
      seen[repo] = true
      found[#found + 1] = repo
    end
  end

  add(root)
  local scanner = vim.uv.fs_scandir(root)
  if not scanner then
    return found
  end

  local entries = 0
  while entries < MAX_ENTRIES do
    local name, kind = vim.uv.fs_scandir_next(scanner)
    if not name then
      break
    end
    entries = entries + 1
    if kind == "directory" then
      local child = vim.fs.joinpath(root, name)
      local child_info = vim.uv.fs_lstat(child)
      if child_info and child_info.type == "directory" and has_git_marker(child) then
        add(child)
      end
    end
  end

  table.sort(found)
  return found
end

local function repos()
  if not repositories then
    repositories = discover_repositories()
  end
  return repositories
end

local function register_statuses()
  local neo_tree = require("neo-tree").ensure_config()
  local git = require("neo-tree.git")
  for _, repo in ipairs(repos()) do
    git.status_async(repo, nil, neo_tree.git_status_async_options)
  end
end

local function line_changes(repo)
  local result = vim.system(
    { "git", "-C", repo, "diff", "--numstat", "HEAD", "--" },
    { text = true }
  ):wait(2000)
  if result.code ~= 0 then
    return 0, 0
  end

  local additions, deletions = 0, 0
  for line in result.stdout:gmatch("[^\n]+") do
    local added, deleted = line:match("^(%d+)%s+(%d+)%s+")
    additions = additions + (tonumber(added) or 0)
    deletions = deletions + (tonumber(deleted) or 0)
  end
  return additions, deletions
end

local function status_item(repo)
  local result = vim.system(
    { "git", "-C", repo, "status", "--short", "--untracked-files=normal" },
    { text = true }
  ):wait(2000)
  if result.code ~= 0 then
    return { path = repo, text = vim.fs.basename(repo) .. "  unavailable" }
  end

  local staged, changed, untracked = 0, 0, 0
  for line in result.stdout:gmatch("[^\n]+") do
    local code = line:sub(1, 2)
    if code == "??" then
      untracked = untracked + 1
    else
      if code:sub(1, 1) ~= " " then
        staged = staged + 1
      end
      if code:sub(2, 2) ~= " " then
        changed = changed + 1
      end
    end
  end

  local additions, deletions = line_changes(repo)
  local parts = {}
  if staged > 0 then
    parts[#parts + 1] = staged .. " staged"
  end
  if changed > 0 then
    parts[#parts + 1] = changed .. " changed"
  end
  if untracked > 0 then
    parts[#parts + 1] = untracked .. " untracked"
  end
  if #parts == 0 then
    parts[1] = "clean"
  end

  return {
    additions = additions,
    deletions = deletions,
    path = repo,
    text = string.format(
      "%-24s +%-6d -%-6d %s",
      vim.fs.basename(repo),
      additions,
      deletions,
      table.concat(parts, " · ")
    ),
  }
end

local function show_status_items(buf_id, items, query)
  MiniPick.default_show(buf_id, items, query)
  vim.api.nvim_buf_clear_namespace(buf_id, picker_namespace, 0, -1)
  for row, item in ipairs(items) do
    if item.additions then
      local line = item.text
      local add_start, add_end = line:find("+" .. item.additions, 1, true)
      local delete_start, delete_end = line:find("-" .. item.deletions, (add_end or 0) + 1, true)
      if add_start then
        vim.api.nvim_buf_set_extmark(buf_id, picker_namespace, row - 1, add_start - 1, {
          end_col = add_end,
          hl_group = "GitSignsAdd",
          hl_mode = "combine",
          priority = 210,
        })
      end
      if delete_start then
        vim.api.nvim_buf_set_extmark(buf_id, picker_namespace, row - 1, delete_start - 1, {
          end_col = delete_end,
          hl_group = "GitSignsDelete",
          hl_mode = "combine",
          priority = 210,
        })
      end
    end
  end
end

local function open_repository_status(repo)
  require("neo-tree.command").execute({
    action = "focus",
    source = "git_status",
    position = "left",
    dir = repo,
  })
end

function M.open_status()
  local available = repos()
  if #available == 0 then
    vim.notify("No Git repositories found at this workspace root", vim.log.levels.WARN)
    return
  end
  if #available == 1 then
    open_repository_status(available[1])
    return
  end

  local items = vim.tbl_map(status_item, available)
  MiniPick.start({
    mappings = {
      move_down = "j",
      move_up = "k",
    },
    source = {
      name = "Git repositories",
      items = items,
      show = show_status_items,
      choose = function(item)
        vim.schedule(function()
          open_repository_status(item.path)
        end)
      end,
    },
  })
end

function M.setup()
  register_statuses()
end

return M
