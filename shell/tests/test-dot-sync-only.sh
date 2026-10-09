#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export HOME="$root/home" DOT_TEST_REPO="$root/repo" DOT_TEST_TRACE="$root/trace"
mkdir -p "$HOME/.pi/agent" "$DOT_TEST_REPO/shell/.local/bin" "$DOT_TEST_REPO/pi/.pi/agent" "$root/bin"
cp "$repo/shell/.local/bin/dot" "$DOT_TEST_REPO/shell/.local/bin/dot"
printf '{"deviceId":"keep-this-machine","packages":["local-package"]}\n' > "$DOT_TEST_REPO/pi/.pi/agent/settings.json"
ln -s "$DOT_TEST_REPO/pi/.pi/agent/settings.json" "$HOME/.pi/agent/settings.json"
cat > "$root/bin/git" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOT_TEST_TRACE"
case "$*" in
 *'rev-parse --show-toplevel') printf '%s\n' "$DOT_TEST_REPO" ;;
 *'status --porcelain') [[ ${DOT_TEST_DIRTY:-false} == false ]] || printf ' M unfinished.ts\n' ;;
 *'pull --ff-only') ;;
 *) echo 'unexpected Git operation' >&2; exit 99 ;;
esac
MOCK
for program in stow systemctl curl sudo chsh; do
 printf '#!/bin/sh\necho "unexpected side effect" >&2\nexit 99\n' > "$root/bin/$program"
done
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH"
bash "$DOT_TEST_REPO/shell/.local/bin/dot" --sync-only
[[ ! -L "$HOME/.pi/agent/settings.json" ]]
cmp "$HOME/.pi/agent/settings.json" "$DOT_TEST_REPO/pi/.pi/agent/settings.json"
grep -q 'pull --ff-only' "$DOT_TEST_TRACE"
! grep -q restore "$DOT_TEST_TRACE"
: > "$DOT_TEST_TRACE"
if DOT_TEST_DIRTY=true bash "$DOT_TEST_REPO/shell/.local/bin/dot" --sync-only; then
 echo 'dirty checkout was not rejected' >&2; exit 1
fi
! grep -q 'pull --ff-only' "$DOT_TEST_TRACE"
cat > "$root/bin/herdr" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@"
MOCK
chmod +x "$root/bin/herdr"
output=$(bash "$repo/shell/.local/bin/herdr-w")
[[ $output == $'--remote\ndebina\n--remote-keybindings\nserver\n--session\ndefault' ]]
output=$(HERDR_DEV_HOST=ubuntu HERDR_DEV_SESSION=work bash "$repo/shell/.local/bin/herdr-w")
[[ $output == $'--remote\nubuntu\n--remote-keybindings\nserver\n--session\nwork' ]]
printf 'dot sync-only/local settings and Herdr defaults: PASS\n'
