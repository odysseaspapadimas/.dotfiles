#!/usr/bin/env python3
"""Compatibility alias for ordinary Debina Pi. No separate profile or client binding."""
import os
from pathlib import Path
import sys


def clean_environment(source, home=None):
    env = dict(source)
    retired = str(Path.home() / ".pi/profiles/herdr-app")
    for key in ("PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"):
        if env.get(key, "") == retired or env.get(key, "").startswith(retired + "/"):
            env.pop(key, None)
    for key in ("PI_APP_PROFILE", "PI_APP_CLIENT", "PI_SESSION_ID", "PI_SESSION_FILE"):
        env.pop(key, None)
    return env


def command(args, home=None):
    # Accept old saved menu/child commands without persisting their desktop target.
    forwarded = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            forwarded.extend(args[i:])
            break
        if arg == "--app-client":
            i += 2
            continue
        if arg.startswith("--app-client="):
            i += 1
            continue
        forwarded.append(arg)
        i += 1
    return [str(Path.home() / ".pi/agent/bin/pi"), *forwarded]


def main():
    argv = command(sys.argv[1:])
    os.execve(argv[0], argv, clean_environment(os.environ))


if __name__ == "__main__":
    main()
