#!/usr/bin/env python3
"""One-way, allowlisted Herdr preferences; never copy app/core runtime state."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
MAX_SIZE = 8 * 1024 * 1024
PERSONAL = re.compile(r"(?:layouts|themes)/odysseas[-\w]*\.json|mods/odysseas[-\w]+/[\w./-]+")


def allowed(name):
    if not isinstance(name, str):
        return False
    parts = PurePosixPath(name).parts
    return (bool(parts) and not name.startswith("/")
            and "\\" not in name and ":" not in name
            and all(p not in (".", "..") and not p.startswith(".") for p in parts)
            and (name in ("keys.json", "settings.json", "programs.json")
                 or PERSONAL.fullmatch(name) is not None))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def export_profile(source):
    files = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"profile symlinks are not allowed: {path}")
        if not path.is_file():
            continue
        name = path.relative_to(source).as_posix()
        if not allowed(name):
            raise ValueError(f"not a portable preference: {name}")
        data = path.read_bytes()
        files.append({"path": name, "sha256": digest(data),
                      "content": base64.b64encode(data).decode("ascii")})
    payload = {"schema": 1, "files": files}
    validate(payload)
    return payload


def validate(payload):
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ValueError("unsupported profile schema")
    decoded = {}
    total = 0
    for item in payload.get("files", []):
        name = item.get("path", "")
        if not allowed(name) or name in decoded:
            raise ValueError(f"unsafe or duplicate profile path: {name!r}")
        data = base64.b64decode(item["content"], validate=True)
        total += len(data)
        if total > MAX_SIZE or digest(data) != item["sha256"]:
            raise ValueError(f"profile size/checksum failure: {name}")
        if name.endswith(".json"):
            if not isinstance(json.loads(data), dict):
                raise ValueError(f"JSON preference must be an object: {name}")
        decoded[name] = data
    if not {"keys.json", "settings.json"} <= decoded.keys():
        raise ValueError("profile must include keys.json and settings.json")
    return decoded


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".profile-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def apply_profile(payload, home, state):
    decoded = validate(payload)  # Validate the entire batch before touching live files.
    home.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = state / "backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    targets = {}
    for name, data in decoded.items():
        target = home / name
        if target.is_symlink() or not target.parent.resolve().is_relative_to(home.resolve()):
            raise ValueError(f"refusing destination symlink outside app home: {name}")
        targets[name] = target
    changed = []
    for name, data in decoded.items():
        target = targets[name]
        if target.is_file() and target.read_bytes() == data:
            continue
        if target.exists():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        atomic_write(target, data)
        changed.append(name)
    revision = digest(json.dumps(payload, sort_keys=True).encode())
    atomic_write(state / "last-sync.json", json.dumps({
        "revision": revision, "files": {name: digest(data) for name, data in decoded.items()},
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2).encode() + b"\n")
    return {"revision": revision, "changed": changed, "files": len(decoded)}


def default_home():
    return Path(os.environ.get("HERDR_APP_HOME") or
                Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "herdr-app")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("export", "sync"))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--host", default="debina")
    parser.add_argument("--app-home", type=Path, default=default_home())
    parser.add_argument("--state-home", type=Path, default=Path.home() / ".local/state/herdr-profile")
    args = parser.parse_args()
    if args.action == "export":
        print(json.dumps(export_profile(args.source or ROOT / "profile"), separators=(",", ":")))
        return
    config = Path.home() / ".config/herdr-profile/source.json"
    options = json.loads(config.read_text()) if config.exists() else {}
    source = args.source or (Path(options["source"]).expanduser() if "source" in options else None)
    if source:
        payload = export_profile(source)
    else:
        host = options.get("host", args.host)
        if host.startswith("-"):
            raise ValueError("invalid SSH host")
        result = subprocess.run([
            "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5",
            "-o", "ServerAliveCountMax=1", host,
            "python3 ~/.dotfiles/herdr-app/profile.py export",
        ], stdin=subprocess.DEVNULL, capture_output=True, timeout=20, check=True)
        if len(result.stdout) > MAX_SIZE * 2:
            raise ValueError("profile response is too large")
        payload = json.loads(result.stdout)
    print(json.dumps(apply_profile(payload, args.app_home, args.state_home)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"herdr-profile: {error}", file=sys.stderr)
        sys.exit(1)
