#!/usr/bin/env python3
"""Live automatic-routing test. Own space only; restore both original views."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

UI = str(Path.home() / ".local/bin/herdr-ui")
CLIENTS = ("omarchy", "windows")


def call(action, command=None, values=None, client=None, destructive=False, env=None):
    argv = [UI]
    if client:
        argv += ["--client", client]
    if destructive:
        argv += ["--allow-destructive"]
    argv += [action]
    if command:
        argv += [command, json.dumps(values or {}, ensure_ascii=False)]
    return json.loads(subprocess.check_output(argv, text=True, env=env))


def hc(*args):
    return json.loads(subprocess.check_output(["hc", *args], text=True))


def test():
    before = {client: call("status", client=client) for client in CLIENTS}
    owned = None
    try:
        created = call("do", "space.new", {"name": 'Shared routing test "Ω"', "folder": "/tmp", "tab": "Shell"})
        owned = created["space"]
        assert created["_routing"]["applied"] == list(CLIENTS), created
        first = created["terminal"]
        env = dict(os.environ, HC_TERMINAL_ID=first.removeprefix("debina/"))
        current = call("current", env=env)
        assert current["space"] == owned, current
        new = call("do", "tab.new", {"space": owned, "name": "Shared Pi", "folder": "/tmp", "argv": ["pi"]})
        assert new["_routing"]["applied"] == list(CLIENTS), new
        terminal = new["terminal"].removeprefix("debina/")
        until = time.monotonic() + 30
        while True:
            state = hc("get", terminal)
            if (state.get("status") or {}).get("app") == "pi":
                break
            if time.monotonic() > until:
                raise AssertionError(state)
            time.sleep(.2)
        # A real inference confirms that the existing login works, not a fresh
        # profile's /login prompt. Send only into this test's newly owned Pi.
        parent = os.environ.get("PI_SESSION_ID")
        prompt = "Use herdr_app action current and pi_sessions action status with id self (read-only). "
        if parent:
            prompt += f"Also inspect pi_sessions status id {parent}, the already-running old Herdr parent. Do not resume or launch it. "
        prompt += "Then reply exactly HERDR_SHARED_OK. Do not change files, focus, layouts or terminals."
        result = hc("send", terminal, prompt, "--wait", "--timeout", "90")
        screen = subprocess.check_output(["hc", "read", terminal], text=True)
        assert screen.count("HERDR_SHARED_OK") >= 2, (result, screen)
        assert not any(s in screen for s in ("No API key found", "Please log in", "Extension error")), screen
        registered = hc("get", terminal)
        records = [json.loads(line) for line in Path(registered["labels"]["pi-sessions.path"]).read_text().splitlines()]
        tools = [r["message"] for r in records if r.get("type") == "message" and r["message"].get("role") == "toolResult"]
        assert any(m.get("toolName") == "herdr_app" and not m.get("isError") for m in tools), tools
        statuses = [m["details"] for m in tools if m.get("toolName") == "pi_sessions" and not m.get("isError")]
        assert any(any(p["pane_id"] == terminal for p in m.get("runtimes", [])) for m in statuses), statuses
        if parent:
            assert any(m.get("session", {}).get("sessionId") == parent and m.get("status") != "stopped" and
                       any(p["pane_id"].startswith("w") for p in m.get("runtimes", [])) for m in statuses), statuses
        split = call("do", "pane.split", {"pane": current["pane"], "direction": "down"})
        call("do", "pane.focus", {"terminal": "debina/" + terminal})
        observed = {}
        for client in CLIENTS:
            state = call("status", client=client)
            assert state["tab"] == new["tab"], state
            data = call("ls", client=client)
            space = next(s for s in data["spaces"] if s["id"] == owned)
            tab = next(t for t in space["tabs"] if t["id"] == new["tab"])
            assert tab["terminals"][0]["terminal"] == "debina/" + terminal, tab
            assert state["focused_pane"] == tab["terminals"][0]["pane"], state
            observed[client] = {"tab": state["tab"], "pane": state["focused_pane"], "terminal": tab["terminals"][0]["terminal"]}
        call("do", "layout.switch", {"name": "terminals"})
        for client in CLIENTS:
            assert call("status", client=client)["layout"] == "terminals"
        print(json.dumps({"result": "PASS", "screens": observed, "pid": hc("get", terminal)["pid"],
                          "split": split, "ordinary_pi_existing_login": True}))
    finally:
        if owned:
            call("do", "space.close", {"id": owned}, destructive=True)
        for client, state in before.items():
            call("do", "layout.switch", {"name": state["layout"]}, client=client)
            if state.get("focused_pane"):
                call("do", "pane.focus", {"pane": state["focused_pane"]}, client=client)
            after = call("status", client=client)
            assert after["layout"] == state["layout"] and after["focused_pane"] == state["focused_pane"], (state, after)
        print("Original screens restored; only owned test space closed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", required=True)
    parser.parse_args()
    test()
