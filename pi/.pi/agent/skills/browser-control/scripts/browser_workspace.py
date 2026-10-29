#!/usr/bin/env python3
"""Ensure Omarchy's browser workspace is ready, without a per-agent MCP server."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
import uuid

from desktop import SetupError, json_run, valid_profile, valid_session


PORTD = "http://127.0.0.1:43117"
CLI_ENV = {**os.environ, "BROWSER_CONTROL_PORT": "19989", "BROWSER_CONTROL_AUTOSTART": "false"}


def api(path, *, post=False):
    request = Request(PORTD + path, data=b"" if post else None)
    try:
        with urlopen(request, timeout=4) as response:
            data = response.read(2 * 1024 * 1024)
        return json.loads(data) if data else None
    except (OSError, ValueError, URLError) as error:
        raise SetupError(f"portd control channel unavailable: {error}") from error


def reverse_mapping(status):
    if not status.get("connected"):
        raise SetupError("portd is not connected to this development host")
    mappings = [item for item in status.get("reverse_tunnels", []) if item.get("remote_port") == 19989]
    if any(item.get("local_port") != 19989 for item in mappings):
        raise SetupError("portd's remote 19989 already maps elsewhere; refusing to replace it")
    return mappings[0] if mappings else None


def ensure_tunnel(timeout):
    deadline = time.monotonic() + timeout
    while True:
        try:
            status = api("/api/status")
        except SetupError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)
            continue
        mapping = reverse_mapping(status)
        break
    if mapping is None:
        # Unlike blindly toggling, only enable when no stored mapping exists.
        # The caller holds the local client lock across this read-modify-write.
        api("/api/reverse/19989/19989/toggle", post=True)
    while time.monotonic() < deadline:
        mapping = reverse_mapping(api("/api/status"))
        if mapping and mapping.get("state") == "active":
            return
        time.sleep(0.5)
    raise SetupError("portd's browser reverse tunnel did not become active")


def mapped_url(value, status):
    try:
        parsed = urlsplit(value)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise SetupError("invalid development URL") from error
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise SetupError("url expects an http(s) loopback URL on the development host")
    if parsed.username or parsed.password or not status.get("connected"):
        raise SetupError("URL credentials are forbidden and portd must be connected")
    matches = [item for item in status.get("tunnels", []) if item.get("remote_port") == port
               and item.get("state") == "active" and item.get("local_port")]
    if len(matches) != 1:
        raise SetupError(f"no unique active desktop-local portd mapping for development port {port}")
    return urlunsplit((parsed.scheme, f"127.0.0.1:{int(matches[0]['local_port'])}",
                       parsed.path, parsed.query, parsed.fragment))


def verify_forwarded_relay(status, receipt):
    if not status.get("extension", {}).get("connected"):
        raise SetupError("forwarded relay has no connected browser extension")
    if status.get("relay", {}).get("stale"):
        raise SetupError("Debina CLI and desktop relay builds differ; coordinate an upgrade")
    if status.get("relay", {}).get("buildId") != receipt["relay_build"]:
        raise SetupError("forwarded relay does not match the selected desktop")
    if not any(item.get("id") == receipt["session"] and
               item.get("createdAt") == receipt["session_created_at"] for item in status.get("sessions", [])):
        raise SetupError("forwarded relay does not contain the selected desktop's session; "
                         "check which desktop owns portd's reverse tunnel")


def ensure(args):
    # No code on the desktop is installed or updated. Send the bundled helper
    # over authenticated SSH, using strict existing known-host verification.
    if args.desktop.startswith("-") or not args.desktop.strip():
        raise SetupError("invalid SSH desktop target")
    session = args.session or "agent-" + uuid.uuid4().hex[:16]
    remote_args = ["python3", "-", "--workspace", str(args.workspace), "--profile", args.profile,
                   "--session", session, "--timeout", str(args.timeout)]
    if args.read_only:
        remote_args.append("--read-only")
    command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
               args.desktop, shlex.join(remote_args)]
    lock_dir = Path.home() / ".cache/browser-workspace"
    lock_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (lock_dir / "client.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            result = subprocess.run(command, input=Path(__file__).with_name("desktop.py").read_text(),
                                    capture_output=True, text=True, timeout=args.timeout * 4 + 30)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SetupError(f"desktop SSH bootstrap failed: {error}") from error
        if result.returncode:
            raise SetupError(result.stderr.strip()[-2500:] or "desktop bootstrap failed")
        try:
            receipt = json.loads(result.stdout)
        except ValueError as error:
            raise SetupError("desktop bootstrap returned invalid JSON") from error
        ensure_tunnel(args.timeout)
        status = json_run(["browser-control", "status", "--json"], env=CLI_ENV)
        verify_forwarded_relay(status, receipt)
        page = json_run(["browser-control", "execute", "--session", session, "--json",
                         "return {url: page.url(), title: await page.title()}"],
                        timeout=args.timeout, env=CLI_ENV)
        if not page.get("ok"):
            raise SetupError("page read through the forwarded relay failed")
        return {**receipt, "ready": True, "autostart_on_development_host": False,
                "continue": f"BROWSER_CONTROL_AUTOSTART=false BROWSER_CONTROL_PORT=19989 "
                            f"browser-control execute --session {session} --json '<code>'"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    ready = commands.add_parser("ensure", help="launch/reuse the managed Chromium window and ensure a live session")
    ready.add_argument("--desktop", default=os.environ.get("BROWSER_CONTROL_DESKTOP", "odysseas@omarchy-mac"))
    ready.add_argument("--workspace", type=int, default=3)
    ready.add_argument("--profile", type=valid_profile, default="Profile 1")
    ready.add_argument("--session", type=valid_session)
    ready.add_argument("--timeout", type=int, default=40)
    ready.add_argument("--read-only", action="store_true")
    url = commands.add_parser("url", help="resolve a development-host URL to the actual desktop-local port")
    url.add_argument("value")
    commands.add_parser("status", help="observe the tunnel and relay without opening a browser")
    args = parser.parse_args()
    try:
        if args.command == "ensure":
            if not 1 <= args.workspace <= 100 or not 5 <= args.timeout <= 120:
                parser.error("workspace must be 1–100 and timeout 5–120 seconds")
            output = ensure(args)
        elif args.command == "url":
            print(mapped_url(args.value, api("/api/status")))
            return 0
        else:
            status = api("/api/status")
            mapping = reverse_mapping(status)
            if not mapping or mapping.get("state") != "active":
                raise SetupError("browser reverse tunnel is not active")
            relay = json_run(["browser-control", "status", "--json"], env=CLI_ENV)
            output = {"tunnel": mapping, "relay": relay.get("relay"),
                      "extension_connected": relay.get("extension", {}).get("connected", False),
                      "session_count": len(relay.get("sessions", []))}
        print(json.dumps(output, indent=2))
        return 0
    except (SetupError, OSError) as error:
        print(f"browser-workspace: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
