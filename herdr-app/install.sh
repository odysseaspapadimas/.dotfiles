#!/usr/bin/env bash
# Linux: install a synced launcher without touching old Herdr or live sessions.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [[ ! -x "$HOME/.local/share/herdr-app/herdr-app" ]]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fLsS https://releases.herdr.dev/app/install.sh -o "$installer"
  sh "$installer"
fi
install -d "$HOME/.local/share/herdr-profile" "$HOME/.local/bin" "$HOME/.config/herdr-profile"
install -m 755 "$here/profile.py" "$HOME/.local/share/herdr-profile/profile.py"
install -m 755 "$here/linux/herdr-start" "$HOME/.local/bin/herdr-start"
ln -sfn "$HOME/.local/share/herdr-profile/profile.py" "$HOME/.local/bin/herdr-profile"
python3 - "$here" <<'PY'
import json, socket, sys
from pathlib import Path
here=Path(sys.argv[1])
config=Path.home()/'.config/herdr-profile/source.json'
if not config.exists():
    data={'source':str(here/'profile')} if socket.gethostname().split('.')[0].lower()=='debina' else {'host':'debina'}
    config.write_text(json.dumps(data,indent=2)+'\n')
PY
"$HOME/.local/bin/herdr-profile" sync
install -d "$HOME/.local/share/applications"
python3 - <<'PY'
from pathlib import Path
home=Path.home()
launcher=home/'.local/bin/herdr-start'
p=home/'.local/share/applications/herdr-debina.desktop'
p.write_text(f'''[Desktop Entry]
Type=Application
Name=Herdr (Debina)
Comment=Synced Ctrl+Space profile; agents and terminals on Debina
Exec="{launcher}"
Icon=herdr-app
Terminal=false
Categories=Development;
StartupWMClass=herdr-app
''')
PY
# Initial layout selection only. Later syncs never overwrite local viewing state.
if "$HOME/.local/share/herdr-app/herdr-app" status >/dev/null 2>&1; then
  "$HOME/.local/share/herdr-app/herdr-app" do layout.switch --name odysseas
else
  python3 - <<'PY'
import json
from pathlib import Path
p=Path.home()/'.config/herdr-app/shared.json'
data=json.loads(p.read_text()) if p.exists() else {}
data['layout']='odysseas'
data.setdefault('frame.welcomed','finished')
p.write_text(json.dumps(data,separators=(',',':'))+'\n')
PY
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$HOME/.local/share/applications" || true
fi
printf '\nInstalled Herdr (Debina). Launch: herdr-start\nManual preferences update: herdr-profile sync\n'
