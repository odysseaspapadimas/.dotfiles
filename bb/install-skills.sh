#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/.bb/skills"
target_dir="${BB_SKILLS_TARGET:-$HOME/.bb/skills}"
# BB's user-skill scanner requires regular files, so Stow links are insufficient.
for source_file in "$source_dir"/*/*; do
  [[ -f $source_file ]] || continue
  relative="${source_file#"$source_dir"/}"
  destination="$target_dir/$relative"
  mkdir -p -- "$(dirname -- "$destination")"
  temporary="$(mktemp "$(dirname -- "$destination")/.skill.XXXXXX")"
  cp -- "$source_file" "$temporary"
  chmod 644 "$temporary"
  mv -f -- "$temporary" "$destination"
done
