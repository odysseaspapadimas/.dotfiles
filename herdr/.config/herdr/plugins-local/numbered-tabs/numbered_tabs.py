#!/usr/bin/env python3
"""Keep Herdr tab labels prefixed with their current visual position."""

from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

NUMBERED_LABEL = re.compile(r"^\d+ · ")


def semantic_label(label: str) -> str:
    """Remove only the prefix owned by this plugin."""
    return NUMBERED_LABEL.sub("", label, count=1).strip()


def numbered_label(position: int, label: str) -> str:
    semantic = semantic_label(label)
    # A numeric semantic label is Herdr's generated, stable tab number. Replace
    # it with the tab's current visual position instead of preserving it.
    if not semantic or semantic.isdigit():
        return str(position)
    return f"{position} · {semantic}"


def herdr(*args: str) -> dict[str, Any]:
    binary = os.environ.get("HERDR_BIN_PATH", "herdr")
    result = subprocess.run(
        [binary, *args], check=True, capture_output=True, text=True
    )
    return json.loads(result.stdout)


def event_workspace_id() -> str | None:
    direct = os.environ.get("HERDR_WORKSPACE_ID")
    if direct:
        return direct
    try:
        event = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON", "{}"))
    except json.JSONDecodeError:
        return None

    def find(value: Any) -> str | None:
        if isinstance(value, dict):
            workspace = value.get("workspace_id")
            if isinstance(workspace, str):
                return workspace
            for child in value.values():
                found = find(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find(child)
                if found:
                    return found
        return None

    return find(event)


def workspace_ids() -> list[str]:
    current = event_workspace_id()
    if current:
        return [current]
    response = herdr("workspace", "list")
    return [workspace["workspace_id"] for workspace in response["result"]["workspaces"]]


def sync_workspace(workspace_id: str) -> None:
    tabs_response = herdr("tab", "list", "--workspace", workspace_id)
    panes_response = herdr("pane", "list", "--workspace", workspace_id)
    pi_tabs = {
        pane["tab_id"]
        for pane in panes_response["result"]["panes"]
        if pane.get("agent") == "pi"
    }

    for position, tab in enumerate(tabs_response["result"]["tabs"], start=1):
        if tab["tab_id"] in pi_tabs:
            desired = numbered_label(position, tab["label"])
        else:
            # Earlier versions touched every tab. Restore non-Pi labels so
            # label-based integrations such as Project services can reuse them.
            desired = semantic_label(tab["label"])
        if desired != tab["label"]:
            herdr("tab", "rename", tab["tab_id"], desired)


def main() -> None:
    if sys.argv[1:] == ["sync-delayed"]:
        # Close hooks can run before the tab list reflects the removal. Run
        # again after the hook returns so the surviving tabs get renumbered.
        subprocess.Popen(
            [sys.executable, __file__, "sync-after-close"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return
    if sys.argv[1:] == ["sync-after-close"]:
        time.sleep(0.25)
    elif sys.argv[1:] != ["sync"]:
        raise SystemExit("usage: numbered_tabs.py sync")

    state_dir = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", "/tmp"))
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "sync.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for workspace_id in workspace_ids():
            sync_workspace(workspace_id)


if __name__ == "__main__":
    main()
