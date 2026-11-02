#!/usr/bin/env python3
"""Install automatic UI routing and a compatibility alias; never create a Pi profile."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def install(home, packages=False):
    bindir = home / ".local/bin"
    bindir.mkdir(parents=True, exist_ok=True)
    for name, source in (("pi-app", ROOT / "launch.py"), ("herdr-ui", ROOT / "ui.py")):
        source.chmod(0o755)
        dest = bindir / name
        if dest.is_symlink() and dest.resolve() == source:
            continue
        if dest.exists() or dest.is_symlink():
            raise ValueError(f"refusing to replace existing launcher: {dest}")
        dest.symlink_to(source)
    extension = home / ".pi/agent/extensions/herdr-app.ts"
    source = ROOT.parents[1] / ".pi/agent/extensions/herdr-app.ts"
    extension.parent.mkdir(parents=True, exist_ok=True)
    if not extension.exists() and not extension.is_symlink():
        extension.symlink_to(source)
    elif extension.resolve() != source.resolve():
        raise ValueError(f"refusing to replace existing extension: {extension}")
    config = home / ".config/pi-app/clients.json"
    if not config.exists():
        config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        config.write_text(json.dumps({"clients": {
            "omarchy": {"platform": "linux", "host": "odysseas@100.127.147.3", "identity": "~/.ssh/id_ed25519_omarchy"},
            "windows": {"platform": "windows", "host": "odysseas@100.65.140.22", "identity": "~/.ssh/id_ed25519"},
            "debina": {"transport": "local", "app": str(home / ".local/share/herdr-app/herdr-app")},
        }}, indent=2) + "\n")
        config.chmod(0o600)
    print("Installed automatic Herdr App routing. Launch ordinary pi on Debina.")
    print("Existing Pi login, settings and history are reused in place; no credentials are copied.")
    if packages:
        print("--packages is obsolete: ordinary Pi already loads your configured packages.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packages", action="store_true", help="compatibility only; no separate profile is installed")
    args = parser.parse_args()
    install(Path.home(), args.packages)
