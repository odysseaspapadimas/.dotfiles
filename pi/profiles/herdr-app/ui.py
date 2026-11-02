#!/usr/bin/env python3
"""Shared Debina workspace control. Discover screens automatically; mutate shared state once."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import time

LIMIT = 32 * 1024 * 1024
# Keep this small: precise UI operations, not a general remote shell or lifecycle manager.
REQUIRED = {
    "space.new": ("name", "machine"), "space.rename": ("id", "name"),
    "space.move": ("id", "index"), "space.select": ("id",),
    "tab.new": ("space", "name"), "tab.rename": ("id", "name"),
    "tab.move": ("id", "index"), "tab.select": ("id",),
    "tab.settle": ("id",), "tab.unsettle": ("id",),
    "pane.split": ("pane", "direction"), "pane.focus": (), "pane.zoom": ("pane",),
    "agent.focus": ("terminal",), "terminal.peek": ("terminal",),
    "terminal.park": ("terminal",),
    "layout.switch": ("name",), "layout.clone": ("name", "as"),
    "layout.set": ("layout",), "layout.toggle": ("id",),
    "layout.show": ("id",), "layout.hide": ("id",),
    "layout.resize": ("id",), "layout.select": ("stack", "child"),
    "mod.clone": ("name", "as"), "mod.open": ("name",),
    "overlay.close": (), "app.help": (), "app.palette": (),
    "app.settings": (), "app.theme": ("name",),
}
DESTRUCTIVE = {"space.close": ("id",), "tab.close": ("id",),
               "pane.close": ("pane",), "terminal.kill": ("terminal",)}


def validate_command(name, args, allow_destructive=False):
    if not isinstance(args, dict):
        raise ValueError("command args must be an object")
    if name in DESTRUCTIVE and not allow_destructive:
        raise ValueError("closing/killing needs explicit --allow-destructive and user permission or owned-test cleanup")
    required = (REQUIRED | DESTRUCTIVE).get(name)
    if required is None:
        raise ValueError(f"{name!r} is not exposed; app/core stop, restart, update and reset are deliberately unavailable")
    for key in required:
        if key not in args or args[key] is None:
            raise ValueError(f"{name} requires explicit {key}")
    for key in ("id", "pane", "space", "terminal"):
        if key in args and (not isinstance(args[key], str) or not args[key]):
            raise ValueError(f"{key} must be a nonempty string ID")
    if name == "pane.focus" and not (args.get("pane") or args.get("terminal")):
        raise ValueError("pane.focus requires pane or terminal")
    if name == "pane.split" and args["direction"] not in ("right", "down"):
        raise ValueError("pane.split direction must be right or down")
    for key in ("name", "as"):
        if key in args and not isinstance(args[key], str):
            raise ValueError(f"{key} must be a string")
    if name in ("space.new", "tab.new", "layout.switch", "layout.clone", "mod.clone") and not args.get("name"):
        raise ValueError(f"{name} requires a useful name")
    if name == "space.new" and not isinstance(args["machine"], str):
        raise ValueError("machine must be explicit: debina on remote clients, empty string on Debina-local")
    args = dict(args)
    if name in ("space.close", "tab.close"):
        args["confirmed"] = True
    return args


LINUX_SCRIPT = r'''
import base64,json,os,pathlib,subprocess,tempfile
request=json.loads(base64.b64decode(PAYLOAD))
app=str(pathlib.Path.home()/'.local/share/herdr-app/herdr-app')
path=None
try:
    argv=request['argv']
    if request.get('shot'):
        fd,path=tempfile.mkstemp(prefix='herdr-agent-',suffix='.png');os.close(fd)
        argv=['shot',path]
    p=subprocess.run([app,*argv],capture_output=True,timeout=35)
    out={'code':p.returncode,'stdout':p.stdout.decode('utf-8','replace'),'stderr':p.stderr.decode('utf-8','replace')}
    if path and p.returncode==0:
        out['image']=base64.b64encode(pathlib.Path(path).read_bytes()).decode()
    print(json.dumps(out))
finally:
    if path:
        pathlib.Path(path).unlink(missing_ok=True)
'''


def windows_script(request):
    # Set ProcessStartInfo.Arguments ourselves: Windows PowerShell 5's native
    # argument marshalling corrupts embedded JSON quotes when using `& exe @args`.
    argv = request["argv"]
    commandline = subprocess.list2cmdline(argv)
    encoded = base64.b64encode(commandline.encode()).decode()
    return r'''
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$path=$null
try {
    $psi=New-Object Diagnostics.ProcessStartInfo
    $psi.FileName=Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
    $psi.Arguments=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('COMMANDLINE'))
    if (SHOT) {
        $path=Join-Path ([IO.Path]::GetTempPath()) ('herdr-agent-'+[guid]::NewGuid()+'.png')
        $psi.Arguments='shot "'+$path+'"'
    }
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true
    $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $p=New-Object Diagnostics.Process; $p.StartInfo=$psi
    if (-not $p.Start()) { throw 'Could not start Herdr CLI' }
    $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(35000)) { $p.Kill(); throw 'Herdr CLI timed out; inspect before retrying' }
    $result=@{code=$p.ExitCode;stdout=$out.GetAwaiter().GetResult();stderr=$err.GetAwaiter().GetResult()}
    if ($path -and $p.ExitCode -eq 0) { $result.image=[Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) }
    $result | ConvertTo-Json -Compress -Depth 8
} finally { if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path } }
'''.replace("COMMANDLINE", encoded).replace("SHOT", "$true" if request.get("shot") else "$false")


def remote_command(target, request):
    if target["platform"] == "windows":
        script = windows_script(request)
        return "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(script.encode("utf-16-le")).decode()
    if target["platform"] != "linux":
        raise ValueError("unsupported desktop platform")
    payload = base64.b64encode(json.dumps(request, ensure_ascii=False).encode()).decode()
    script = LINUX_SCRIPT.replace("PAYLOAD", repr(payload))
    return "python3 -c " + shlex.quote(script)


def invoke(target, request):
    if target.get("transport") == "local":
        path = None
        try:
            argv = request["argv"]
            if request.get("shot"):
                fd, path = tempfile.mkstemp(suffix=".png"); os.close(fd)
                argv = ["shot", path]
            p = subprocess.run([target["app"], *argv], capture_output=True, timeout=40)
            result = {"code": p.returncode, "stdout": p.stdout.decode(errors="replace"), "stderr": p.stderr.decode(errors="replace")}
            if path and p.returncode == 0:
                result["image"] = base64.b64encode(Path(path).read_bytes()).decode()
            return result
        finally:
            if path:
                Path(path).unlink(missing_ok=True)
    host = target["host"]
    if not isinstance(host, str) or host.startswith("-") or any(c.isspace() for c in host):
        raise ValueError("invalid configured SSH host")
    argv = ["ssh", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"]
    if target.get("identity"):
        argv += ["-o", "IdentitiesOnly=yes", "-i", str(Path(target["identity"]).expanduser())]
    argv += [host, remote_command(target, request)]
    p = subprocess.run(argv, capture_output=True, timeout=50)
    if p.returncode:
        raise ValueError(p.stderr.decode(errors="replace").strip() or f"SSH failed ({p.returncode}); no fallback or retry performed")
    if len(p.stdout) > LIMIT:
        raise ValueError("desktop response exceeds limit")
    return json.loads(p.stdout.decode("utf-8-sig"))


def core_socket(config):
    return config.get("core", {}).get("socket") or str(Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "herdr-core/default.sock")


def core_rpc(config, method, params):
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(5)
        stream.connect(core_socket(config))
        stream.sendall((json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) + "\n").encode())
        data = b""
        while b"\n" not in data:
            chunk = stream.recv(65536)
            if not chunk or len(data) + len(chunk) > LIMIT:
                raise ValueError("invalid core response")
            data += chunk
    result = json.loads(data.split(b"\n", 1)[0])
    if result.get("id") != 1 or "error" in result:
        raise ValueError(f"core {method} failed: {result}")
    return result["result"]


def check_core(config):
    # Private HC_SESSION terminals reuse t1/t2/etc. They must NEVER navigate the
    # default desktop core based on a colliding address, even with --client.
    caller = os.environ.get("HC_TERMINAL_SOCKET")
    expected = core_socket(config)
    if caller and Path(caller).resolve() != Path(expected).resolve():
        raise ValueError("This terminal belongs to a different/private core; refusing to control Debina's default desktop workspace")
    if (os.environ.get("HC_SESSION") or "default") != "default":
        raise ValueError("Private HC_SESSION cannot control Debina's default desktop workspace")
    if caller and config.get("core", {}).get("id"):
        if core_rpc(config, "hello", {})["core"]["id"] != config["core"]["id"]:
            raise ValueError("Debina core identity changed; verify the machine before controlling windows")


def shared_ids(config):
    document = core_rpc(config, "doc.get", {"name": "herdr-app"}).get("value") or {}
    result = set()
    def visit(value):
        if isinstance(value, dict):
            if isinstance(value.get("id"), str):
                result.add(value["id"])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(document)
    return result


# These change only a screen's view. Structural commands are NEVER broadcast.
MIRRORED = {"space.select", "tab.select", "pane.focus", "agent.focus", "terminal.peek",
            "layout.switch", "layout.set", "layout.show", "layout.hide", "layout.resize",
            "layout.select", "app.theme"}
ID_KEYS = {"id", "pane", "space", "terminal"}


def decoded(target, argv):
    result = invoke(target, {"argv": argv})
    if result["code"]:
        raise ValueError(result.get("stderr", "").strip() or result.get("stdout", "").strip() or "window unavailable")
    value = json.loads(result["stdout"])
    if isinstance(value, dict) and "error" in value:
        raise ValueError(str(value["error"]))
    return value


def machine(target):
    return target.get("machine", "" if target.get("transport") == "local" else "debina")


def qualified(value, target):
    if not isinstance(value, str):
        return value
    prefix = machine(target)
    if value.startswith("debina/"):
        value = value[7:]
    elif "/" in value:
        raise ValueError("automatic routing is Debina-only; use an explicit client for another machine")
    return f"{prefix}/{value}" if prefix else value


def target_args(values, target, command, shared_resize=False):
    keys = ID_KEYS if shared_resize or command.startswith(("space.", "tab.", "pane.", "agent.", "terminal.")) else set()
    result = {key: qualified(value, target) if key in keys else value for key, value in values.items()}
    if "machine" in result:
        if result["machine"] not in ("debina", ""):
            raise ValueError("automatic space creation is Debina-only")
        result["machine"] = machine(target)
    return result


def discover(config):
    online, offline = {}, {}
    # Read-only discovery may fail over; a mutation is sent only once, never retried.
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(decoded, target, ["ls"]): name for name, target in config["clients"].items()}
        for future in as_completed(pending):
            name = pending[future]
            target = config["clients"][name]
            try:
                tree = future.result()
                if not isinstance(tree, dict) or not isinstance(tree.get("spaces"), list):
                    raise ValueError("invalid workspace response")
                tree = dict(tree, spaces=[s for s in tree["spaces"] if (s.get("machine") or "") == machine(target)])
                # A local core without a desktop window is offline, never launched.
                online[name] = {"target": target, "tree": tree}
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                offline[name] = str(error)
    online = {name: online[name] for name in config["clients"] if name in online}
    return online, offline


def locate(tree, terminal):
    if not terminal:
        raise ValueError("current requires HC_TERMINAL_ID; inspect ls when outside a core terminal")
    address = terminal.removeprefix("debina/")
    for space in tree["spaces"]:
        for tab in space["tabs"]:
            for item in tab["terminals"]:
                if item["terminal"].removeprefix("debina/") == address:
                    return {"space": space["id"], "tab": tab["id"], "pane": item["pane"], "terminal": item["terminal"]}
    raise ValueError(f"Debina terminal {address} has no visible pane; inspect ls or use hc")


def wait_visible(target, terminal):
    # Mirror propagation is asynchronous. Poll READS, not a mutating UI command.
    until = time.monotonic() + 4
    while True:
        tree = decoded(target, ["ls"])
        try:
            locate(tree, terminal)
            return
        except ValueError:
            if time.monotonic() >= until:
                raise ValueError("new pane has not reached this screen yet; shared creation already succeeded")
            time.sleep(.1)


def automatic(config, action, command=None, values=None):
    online, offline = discover(config)
    if action == "clients":
        return {"mode": "automatic", "online": list(online), "offline": offline}
    if not online:
        raise ValueError("No reachable Herdr App window. Debina jobs remain running. " + json.dumps(offline))
    primary = next(iter(online))
    target = online[primary]["target"]
    routing = {"mode": "automatic", "primary": primary, "online": list(online), "offline": offline}
    if action == "ls":
        return dict(online[primary]["tree"], _routing=routing)
    if action == "current":
        return dict(locate(online[primary]["tree"], os.environ.get("HC_TERMINAL_ID")), _routing=routing)
    if action == "legacy":
        space = next((s for s in online[primary]["tree"]["spaces"] if s.get("name") == "Existing Herdr"), None)
        if not space:
            raise ValueError("The Existing Herdr compatibility view is not open; old agent remains running")
        return automatic(config, "do", "pane.focus", {"terminal": space["tabs"][0]["terminals"][0]["terminal"]})
    if action != "do":
        value = decoded(target, [action])
        return dict(value, _routing=routing) if isinstance(value, dict) else {action: value, "_routing": routing}
    # Validate all inputs/targets BEFORE the first mutation, then apply shared
    # changes once. A failed acknowledgment is not safe grounds for a retry.
    shared_resize = command == "layout.resize" and values["id"].removeprefix("debina/") in shared_ids(config)
    per_screen = {name: target_args(values, item["target"], command, shared_resize) for name, item in online.items()}
    def screen_command(name):
        # Background/parked workers have no pane: peek at the SAME terminal,
        # rather than creating another process or reporting a successful no-op.
        if command == "pane.focus" and values.get("terminal"):
            try:
                locate(online[name]["tree"], values["terminal"])
            except ValueError:
                return "terminal.peek"
        return command
    result = decoded(target, ["do", screen_command(primary), json.dumps(per_screen[primary], ensure_ascii=False)])
    routing["applied"] = [primary]
    errors = {}
    follow_terminal = result.get("terminal") if command in {"space.new", "tab.new", "pane.split"} else None
    for name, item in online.items():
        if name == primary:
            continue
        try:
            if command in MIRRORED and not shared_resize:
                decoded(item["target"], ["do", screen_command(name), json.dumps(per_screen[name], ensure_ascii=False)])
                routing["applied"].append(name)
            elif follow_terminal:
                wait_visible(item["target"], follow_terminal)
                decoded(item["target"], ["do", "pane.focus", json.dumps({"terminal": qualified(follow_terminal, item["target"])})])
                routing["applied"].append(name)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            # The primary already acknowledged success. Expose partial mirroring
            # as data, not an error inviting duplicate creation by a retry.
            errors[name] = str(error)
    if errors:
        routing["view_errors"] = errors
    return dict(result, _routing=routing)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/pi-app/clients.json")
    parser.add_argument("--client", choices=("omarchy", "windows", "debina"))
    parser.add_argument("--allow-destructive", action="store_true")
    parser.add_argument("--output", type=Path, help="local PNG destination for shot; existing files are never overwritten")
    parser.add_argument("action", choices=("clients", "current", "legacy", "status", "ls", "commands", "do", "shot"))
    parser.add_argument("command", nargs="?")
    parser.add_argument("args", nargs="?", default="{}", help="one JSON object, not shell arguments")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    check_core(config)
    values = json.loads(args.args)
    if args.action == "do":
        if not args.client and args.command == "space.new":
            values.setdefault("machine", "debina")
        values = validate_command(args.command, values, args.allow_destructive)
    elif args.command:
        raise ValueError("only do accepts command arguments")
    if not args.client:
        if args.action != "shot":
            print(json.dumps(automatic(config, args.action, args.command, values), ensure_ascii=False))
            return
        online, _ = discover(config)
        if not online:
            raise ValueError("No reachable Herdr App window for a screenshot")
        args.client = next(iter(online))
    target = config["clients"][args.client]
    if args.action == "clients":
        print(json.dumps({"client": args.client, "mode": "explicit override"}))
        return
    if args.action == "current":
        print(json.dumps(locate(decoded(target, ["ls"]), os.environ.get("HC_TERMINAL_ID"))))
        return
    if args.action == "do":
        argv = ["do", args.command, json.dumps(values, ensure_ascii=False, separators=(",", ":"))]
    else:
        argv = [args.action]
    result = invoke(target, {"argv": argv, "shot": args.action == "shot"})
    if result["code"]:
        raise ValueError(result.get("stderr", "").strip() or result.get("stdout", "").strip() or "desktop command failed; inspect before retrying")
    if args.action == "shot":
        data = base64.b64decode(result["image"], validate=True)
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > LIMIT:
            raise ValueError("invalid screenshot response")
        if args.output:
            with args.output.open("xb") as stream:
                stream.write(data)
            path = args.output.resolve()
        else:
            fd, name = tempfile.mkstemp(prefix=f"herdr-{args.client}-", suffix=".png")
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            path = Path(name)
        print(json.dumps({"client": args.client, "path": str(path)}))
    else:
        value = json.loads(result["stdout"])
        if isinstance(value, dict) and "error" in value:
            raise ValueError(str(value["error"]))
        print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"herdr-ui: {error}", file=sys.stderr)
        sys.exit(1)
