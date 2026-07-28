require("catppuccin").setup({
  flavour = "mocha",
  transparent_background = true,
  float = { transparent = true },
  auto_integrations = true,
  lsp_styles = {
    virtual_text = { errors = { "italic" }, hints = { "italic" } },
    underlines = { errors = { "underline" }, hints = { "underline" } },
  },
  integrations = {
    blink_cmp = { style = "bordered" },
    mini = { indentscope_color = "lavender" },
  },
})
vim.cmd.colorscheme("catppuccin")

require("mini.icons").setup()
MiniIcons.mock_nvim_web_devicons()
require("mini.statusline").setup({ use_icons = true })

require("neo-tree").setup({
  auto_clean_after_session_restore = true,
  commands = {
    open_no_focus = function(state)
      local tree_window = state.winid
      require("neo-tree.sources.filesystem.commands").open(state)
      vim.defer_fn(function()
        if tree_window and vim.api.nvim_win_is_valid(tree_window) then
          vim.api.nvim_set_current_win(tree_window)
        end
      end, 10)
    end,
  },
  close_if_last_window = false,
  default_component_configs = {
    git_status = {
      symbols = {
        added = "A",
        deleted = "D",
        modified = "M",
        renamed = "R",
        untracked = "?",
        ignored = "",
        unstaged = "",
        staged = "S",
        conflict = "!",
      },
    },
  },
  enable_git_status = true,
  enable_diagnostics = true,
  filesystem = {
    follow_current_file = { enabled = true },
    filtered_items = { visible = true },
    use_libuv_file_watcher = true,
  },
  window = {
    width = 36,
    mappings = {
      ["O"] = { "open_no_focus", nowait = true },
    },
  },
})
