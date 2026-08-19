# Shared Fish configuration.

# Keep personal commands available to interactive and SSH command shells.
fish_add_path --prepend "$HOME/.local/bin"

if test -d "$HOME/.local/share/omarchy"
    set -gx OMARCHY_PATH "$HOME/.local/share/omarchy"
    fish_add_path --prepend "$OMARCHY_PATH/bin"
end

if status is-interactive
    set -g fish_greeting

    if set -q EDITOR
        set -gx SUDO_EDITOR "$EDITOR"
    end
    set -gx BAT_THEME ansi
    set -gx MANROFFOPT -c
    set -gx MANPAGER "sh -c 'col -bx | bat -l man -p'"

    # Optional toolchain integrations; hosts need not install every tool.
    command -q mise; and mise activate fish | source
    command -q zoxide; and zoxide init fish --cmd cd | source
    command -q starship; and starship init fish | source

    if command -q eza
        alias ls='eza -lh --group-directories-first --icons=auto'
        alias lsa='ls -a'
        alias lt='eza --tree --level=2 --long --icons --git'
        alias lta='lt -a'
    end

    alias ..='cd ..'
    alias ...='cd ../..'
    alias ....='cd ../../..'
    alias g='git'
    alias gcm='git commit -m'
    alias gcam='git commit -a -m'
    alias gcad='git commit -a --amend'
    alias d='docker'
    alias r='rails'
    alias t='tmux attach; or tmux new -s Work'
end
