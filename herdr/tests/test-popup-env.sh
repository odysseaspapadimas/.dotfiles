#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
wrapper="$root/.config/herdr/popup-env"

actual=$(env -i HOME=/home/test PATH=/usr/bin HERDR_SESSION=work \
    /bin/sh "$wrapper" /bin/sh -c 'printf "%s\n%s\n" "$PATH" "$HERDR_SOCKET_PATH"')
expected='/home/test/.local/bin:/usr/bin
/home/test/.config/herdr/sessions/work/herdr.sock'
[ "$actual" = "$expected" ] || {
    printf 'unexpected popup environment:\n%s\n' "$actual" >&2
    exit 1
}

set +e
env -i HOME=/home/test PATH=/usr/bin /bin/sh "$wrapper" /bin/sh -c 'exit 23'
status=$?
set -e
[ "$status" -eq 23 ] || {
    printf 'expected child status 23, got %s\n' "$status" >&2
    exit 1
}

printf 'popup-env tests passed\n'
