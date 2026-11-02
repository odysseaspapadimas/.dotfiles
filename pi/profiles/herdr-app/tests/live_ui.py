#!/usr/bin/env python3
"""Explicit live smoke test: only create/close our own space; restore each window."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

UI = str(Path.home() / ".local/bin/herdr-ui")


def call(client, action, command=None, args=None, destructive=False):
    argv = [UI, "--client", client]
    if destructive:
        argv.append("--allow-destructive")
    argv.append(action)
    if command:
        argv += [command, json.dumps(args or {}, ensure_ascii=False)]
    return json.loads(subprocess.check_output(argv, text=True))


def test(client):
    before = call(client, "status")
    owned = None
    try:
        created = call(client, "do", "space.new", {
            "name": 'Pi isolation test "Ω"', "machine": "debina", "folder": "/tmp",
            "tab": "Owned test shell",
        })
        owned = created["space"]
        data = call(client, "ls")
        space = next(s for s in data["spaces"] if s["id"] == owned)
        assert space["name"] == 'Pi isolation test "Ω"', space
        first = space["tabs"][0]["terminals"][0]
        tab = call(client, "do", "tab.new", {
            "name": 'Quoted "tab" Ω', "space": owned, "folder": "/tmp",
        })
        data = call(client, "ls")
        new_tab = next(t for s in data["spaces"] for t in s["tabs"] if t["id"] == tab["tab"])
        tab_pane = new_tab["terminals"][0]["pane"]
        assert new_tab["name"] == 'Quoted "tab" Ω', new_tab
        right = call(client, "do", "pane.split", {"pane": tab_pane, "direction": "right"})
        split = call(client, "do", "pane.split", {"pane": right["pane"], "direction": "down"})
        call(client, "do", "pane.focus", {"pane": tab_pane})
        assert call(client, "status")["focused_pane"] == tab_pane
        call(client, "do", "pane.focus", {"terminal": split["terminal"]})
        assert call(client, "status")["focused_pane"] == split["pane"]
        call(client, "do", "pane.focus", {"pane": first["pane"]})
        assert call(client, "status")["focused_pane"] == first["pane"]
        call(client, "do", "layout.switch", {"name": "terminals"})
        assert call(client, "status")["layout"] == "terminals"
        call(client, "do", "layout.switch", {"name": before["layout"]})
        # Give native draw a moment, not a program/agent wait.
        time.sleep(.3)
        shot = call(client, "shot")
        print(json.dumps({"client": client, "result": "PASS", "space": owned,
                          "tab": tab, "split": split, "screenshot": shot["path"]}))
    finally:
        if owned:
            call(client, "do", "space.close", {"id": owned}, destructive=True)
        if call(client, "status")["layout"] != before["layout"]:
            call(client, "do", "layout.switch", {"name": before["layout"]})
        if before.get("focused_pane"):
            call(client, "do", "pane.focus", {"pane": before["focused_pane"]})
        after = call(client, "status")
        assert after["focused_pane"] == before["focused_pane"], (before, after)
        assert after["layout"] == before["layout"], (before, after)
        assert not after["errors"], after
        print(json.dumps({"client": client, "restored": True, "errors": after["errors"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", required=True, help="acknowledge live window changes")
    parser.add_argument("clients", nargs="+", choices=["omarchy", "windows"])
    args = parser.parse_args()
    for client in args.clients:
        test(client)
