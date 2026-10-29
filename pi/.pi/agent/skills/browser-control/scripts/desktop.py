#!/usr/bin/env python3
"""Omarchy bootstrap, sent over SSH by browser_workspace.py; stdlib only."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import uuid
from urllib.parse import quote


class SetupError(RuntimeError):
    pass


def run(argv, *, timeout=15, env=None):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SetupError(f"{argv[0]}: {error}") from error
    if result.returncode:
        raise SetupError(f"{argv[0]} failed: {(result.stderr or result.stdout)[-2000:].strip()}")
    return result.stdout


def json_run(argv, **kwargs):
    try:
        return json.loads(run(argv, **kwargs))
    except ValueError as error:
        raise SetupError(f"{argv[0]} returned invalid JSON") from error


def valid_profile(value):
    if not value or value in (".", "..") or "/" in value or "\\" in value or any(ord(c) < 32 for c in value):
        raise argparse.ArgumentTypeError("profile must be a single Chromium profile directory name")
    return value


def valid_session(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value):
        raise argparse.ArgumentTypeError("session must contain 1–80 lowercase letters, digits or hyphens")
    return value


def chromium_windows(clients):
    return [client for client in clients if client.get("mapped", True) and
            "chromium" in (client.get("class", "") + " " + client.get("initialClass", "")).lower()]


def bootstrap_title_matches(title, marker):
    return bool(isinstance(marker, str) and re.fullmatch(r"Browser Control bootstrap [0-9a-f]{32}", marker)
                and (title == marker or title.startswith(marker + " - ")))


def saved_window(windows, state, instance, profile):
    if not isinstance(state, dict) or state.get("instance") != instance or state.get("profile") != profile:
        return None
    if not state.get("address"):
        # Recover only our uniquely marked pending launch after a timeout/crash.
        return next((window for window in windows if bootstrap_title_matches(
            window.get("title", ""), state.get("marker"))), None)
    return next((window for window in windows if window.get("address") == state.get("address")
                 and window.get("pid") == state.get("pid")), None)


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.chmod(0o600)
    temporary.replace(path)


def require_extension(profile_root):
    """Read metadata only. Never edit Chromium's Preferences or copy its profile."""
    for filename in ("Preferences", "Secure Preferences"):
        try:
            preferences = json.loads((profile_root / filename).read_text())
        except (OSError, ValueError):
            continue
        for entry in preferences.get("extensions", {}).get("settings", {}).values():
            path = entry.get("path", "")
            if "browser-control" not in path:
                continue
            manifest = Path(path) / "manifest.json"
            if manifest.is_file() and not entry.get("disable_reasons"):
                return
    raise SetupError(f"Browser Control is not installed/enabled in {profile_root}; "
                     "load its unpacked extension once in Chromium, then retry")


def bootstrap(args):
    instances = json_run(["hyprctl", "instances", "-j"])
    if len(instances) != 1:
        raise SetupError("expected exactly one running Hyprland session; refusing to guess")
    instance = instances[0]["instance"]
    hypr = ["hyprctl", "-i", instance]
    profile_root = Path.home() / ".config/chromium" / args.profile
    require_extension(profile_root)
    browser = shutil.which("chromium")
    cli = shutil.which("browser-control")
    if not browser or not cli:
        raise SetupError("Chromium and browser-control must be installed on Omarchy")
    env = {**os.environ, "BROWSER_CONTROL_PORT": "19989", "BROWSER_CONTROL_AUTOSTART": "true"}

    # The compositor launches the GUI process in its own desktop environment,
    # not in SSH's environment. Only our exact recorded window can be reused.
    state_dir = Path.home() / ".local/state/browser-workspace"
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_dir / "desktop.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = state_dir / "window.json"
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            state = {}
        windows = chromium_windows(json_run(hypr + ["-j", "clients"]))
        window = saved_window(windows, state, instance, args.profile)
        if windows and (window is None or len(windows) != 1):
            raise SetupError("unmanaged or multiple Chromium windows found; refusing to move/adopt "
                             "personal windows. Keep Chromium for this automation profile and use "
                             "your normal browser separately, or close Chromium and retry")
        initial_status = json_run([cli, "status", "--json"], env=env)
        if initial_status.get("relay", {}).get("stale"):
            raise SetupError("desktop relay build is stale; coordinate an upgrade, do not auto-restart it")
        if window is None and initial_status.get("extension", {}).get("connected"):
            raise SetupError("relay is already connected to an unmanaged browser/profile; "
                             "keep the extension enabled only in the automation profile")
        created = window is None
        previous = json_run(hypr + ["-j", "activewindow"]).get("address")
        if created:
            marker = "Browser Control bootstrap " + uuid.uuid4().hex
            save_state(state_path, {"instance": instance, "profile": args.profile, "marker": marker})
            start_url = "data:text/html," + quote(
                f"<title>{marker}</title><h1>Browser Control</h1>"
                "<p>This window is reserved for coding-agent browser sessions.</p>")
            command = shlex.join([browser, "--profile-directory=" + args.profile,
                                  "--no-first-run", "--no-default-browser-check",
                                  "--new-window", start_url])
            # Hyprland 0.56+ dispatch accepts a Lua dispatcher expression,
            # not the legacy `exec [workspace ...]` argument syntax.
            run(hypr + ["dispatch", "hl.dsp.exec_cmd(" + json.dumps(command, ensure_ascii=False) +
                        ', {workspace = "' + str(args.workspace) + ' silent"})'])
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline:
                windows = chromium_windows(json_run(hypr + ["-j", "clients"]))
                matches = [item for item in windows if bootstrap_title_matches(item.get("title", ""), marker)]
                if len(windows) == 1 and len(matches) == 1:
                    window = matches[0]
                    break
                time.sleep(0.4)
            if window is None:
                raise SetupError("Chromium did not expose exactly one identifiable bootstrap window; "
                                 "inspect Omarchy (profile picker, restore prompt, or extra windows)")
        state = {"instance": instance, "profile": args.profile,
                 "address": window["address"], "pid": window["pid"]}
        save_state(state_path, state)
        if window.get("workspace", {}).get("id") != args.workspace:
            run(hypr + ["dispatch", "hl.dsp.window.move({window = " +
                        json.dumps("address:" + window["address"]) + ', workspace = "' +
                        str(args.workspace) + '", follow = false})'])

        # Start only an absent desktop service, never restart an active one.
        service = subprocess.run(["systemctl", "--user", "is-active", "--quiet", "portd.service"],
                                 capture_output=True, timeout=10)
        if service.returncode:
            run(["systemctl", "--user", "start", "portd.service"])
        status = json_run([cli, "status", "--json"], env=env)
        if status.get("relay", {}).get("stale"):
            raise SetupError("desktop relay build is stale; coordinate an upgrade, do not auto-restart it")
        deadline = time.monotonic() + args.timeout
        # A normal operational call may start a missing relay ON THE DESKTOP.
        # It will never replace an existing relay. Explicit ids avoid shared defaults.
        sessions = {item["id"]: item for item in status.get("sessions", [])}
        if args.session not in sessions:
            command = [cli, "session", "new", args.session]
            if args.read_only:
                command.append("--read-only")
            run(command, timeout=args.timeout, env=env)
        elif args.read_only and not sessions[args.session].get("readOnly", False):
            raise SetupError("existing session cannot be verified as read-only; choose a fresh id")
        while time.monotonic() < deadline:
            status = json_run([cli, "status", "--json"], env=env)
            if status.get("extension", {}).get("connected"):
                break
            time.sleep(0.5)
        else:
            raise SetupError("extension did not connect; check that Browser Control is enabled in "
                             "Profile 1. Do not bypass permissions or launch another relay")
        extension = status["extension"]
        if extension.get("protocolCompatible") is False:
            raise SetupError("extension protocol is incompatible; update/reload it manually")
        result = json_run([cli, "execute", "--session", args.session, "--json",
                           "return {url: page.url(), title: await page.title()}"],
                          timeout=args.timeout, env=env)
        if not result.get("ok"):
            raise SetupError("desktop browser page verification failed")
        windows = chromium_windows(json_run(hypr + ["-j", "clients"]))
        window = saved_window(windows, state, instance, args.profile)
        if len(windows) != 1 or window is None or window.get("workspace", {}).get("id") != args.workspace:
            raise SetupError("automation window/workspace changed during bootstrap; refusing to guess")
        # A new GUI app can request focus despite a silent workspace rule.
        # Restore only if the app we launched is now focused, not if the user
        # independently switched to another window during bootstrap.
        active = json_run(hypr + ["-j", "activewindow"]).get("address")
        if previous and previous != window["address"] and active == window["address"]:
            clients = json_run(hypr + ["-j", "clients"])
            if any(item.get("address") == previous for item in clients):
                run(hypr + ["dispatch", "hl.dsp.focus({window = " +
                            json.dumps("address:" + previous) + "})"])
        status = json_run([cli, "status", "--json"], env=env)
        session = next(item for item in status["sessions"] if item["id"] == args.session)
        return {"desktop": socket.gethostname(), "workspace": args.workspace,
                "window": window["address"], "profile": args.profile, "created_window": created,
                "session": args.session, "session_created_at": session["createdAt"],
                "relay_build": status["relay"].get("buildId"), "extension_connected": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=int, default=3)
    parser.add_argument("--profile", type=valid_profile, default="Profile 1")
    parser.add_argument("--session", type=valid_session, required=True)
    parser.add_argument("--timeout", type=int, default=40)
    parser.add_argument("--read-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workspace <= 100 or not 5 <= args.timeout <= 120:
        parser.error("workspace must be 1–100 and timeout 5–120 seconds")
    try:
        print(json.dumps(bootstrap(args)))
    except (SetupError, OSError, subprocess.TimeoutExpired, StopIteration) as error:
        print(f"browser-workspace desktop: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
