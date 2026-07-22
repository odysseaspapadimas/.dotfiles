#!/usr/bin/env python3
"""Move the current Herdr tab one position left or right."""

import json
import os
import socket
import sys
import uuid


def request(method: str, params: dict) -> dict:
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if not socket_path:
        raise RuntimeError("HERDR_SOCKET_PATH is not set")

    payload = {
        "id": f"move-tab:{uuid.uuid4().hex}",
        "method": method,
        "params": params,
    }
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(socket_path)
        client.sendall(json.dumps(payload).encode() + b"\n")
        response = b""
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                break
            response += chunk

    if not response:
        raise RuntimeError(f"no response to {method}")
    result = json.loads(response.split(b"\n", 1)[0])
    if "error" in result:
        raise RuntimeError(result["error"].get("message", str(result["error"])))
    return result["result"]


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"left", "right"}:
        raise SystemExit(f"usage: {sys.argv[0]} left|right")

    # Custom command keybindings receive HERDR_ACTIVE_* context. Fall back to
    # the pane-scoped variables so the script is also convenient to run by hand.
    tab_id = os.environ.get("HERDR_ACTIVE_TAB_ID") or os.environ.get("HERDR_TAB_ID")
    workspace_id = os.environ.get("HERDR_ACTIVE_WORKSPACE_ID") or os.environ.get("HERDR_WORKSPACE_ID")
    if not tab_id or not workspace_id:
        raise RuntimeError("no active Herdr tab context was provided")

    tabs = request("tab.list", {"workspace_id": workspace_id})["tabs"]
    current_index = next(i for i, tab in enumerate(tabs) if tab["tab_id"] == tab_id)
    if sys.argv[1] == "left":
        if current_index == 0:
            return
        insert_index = current_index - 1
    else:
        if current_index == len(tabs) - 1:
            return
        # The API index is an insertion slot in the pre-move list. Account for
        # the current tab being removed before it is inserted further right.
        insert_index = current_index + 2

    request("tab.move", {"tab_id": tab_id, "insert_index": insert_index})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"move-current-tab: {error}", file=sys.stderr)
        raise SystemExit(1)
