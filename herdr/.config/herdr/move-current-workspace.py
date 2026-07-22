#!/usr/bin/env python3
"""Move the active Herdr workspace one position up or down."""

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
        "id": f"move-workspace:{uuid.uuid4().hex}",
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
    if len(sys.argv) != 2 or sys.argv[1] not in {"up", "down"}:
        raise SystemExit(f"usage: {sys.argv[0]} up|down")

    workspace_id = os.environ.get("HERDR_ACTIVE_WORKSPACE_ID") or os.environ.get("HERDR_WORKSPACE_ID")
    if not workspace_id:
        raise RuntimeError("no active Herdr workspace context was provided")

    workspaces = request("workspace.list", {})["workspaces"]
    current_index = next(
        i for i, workspace in enumerate(workspaces)
        if workspace["workspace_id"] == workspace_id
    )

    if sys.argv[1] == "up":
        if current_index == 0:
            return
        insert_index = current_index - 1
    else:
        if current_index == len(workspaces) - 1:
            return
        insert_index = current_index + 2

    request("workspace.move", {
        "workspace_id": workspace_id,
        "insert_index": insert_index,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"move-current-workspace: {error}", file=sys.stderr)
        raise SystemExit(1)
