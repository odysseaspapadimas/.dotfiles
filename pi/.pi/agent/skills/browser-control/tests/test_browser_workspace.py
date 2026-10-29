"""No SSH, compositor, browser, relay or live portd is touched by these tests."""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import browser_workspace as client
import desktop


def tunnel(local_port=19989, state="active"):
    return {"remote_port": 19989, "local_port": local_port, "state": state}


class ValidationTests(unittest.TestCase):
    def test_profile_is_a_single_directory(self):
        self.assertEqual(desktop.valid_profile("Profile 1"), "Profile 1")
        for value in ("", ".", "..", "../Default", "/tmp/profile", "x\\y"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                desktop.valid_profile(value)

    def test_sessions_are_safe_explicit_identifiers(self):
        self.assertEqual(desktop.valid_session("agent-ui-123"), "agent-ui-123")
        for value in ("-bad", "UPPER", "with space", "x;true", "x" * 81):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                desktop.valid_session(value)

    def test_saved_window_needs_address_pid_profile_and_instance(self):
        window = {"address": "0xab", "pid": 123, "class": "chromium"}
        state = {**window, "profile": "Profile 1", "instance": "desktop-a"}
        self.assertEqual(desktop.saved_window([window], state, "desktop-a", "Profile 1"), window)
        for key, value in (("address", "0xcd"), ("pid", 456), ("profile", "Default"), ("instance", "desktop-b")):
            with self.subTest(key=key):
                self.assertIsNone(desktop.saved_window([window], {**state, key: value}, "desktop-a", "Profile 1"))

    def test_pending_bootstrap_recovers_chromium_title_suffix(self):
        marker = "Browser Control bootstrap " + "a" * 32
        window = {"address": "0xab", "pid": 123, "title": marker + " - Chromium"}
        state = {"instance": "desktop-a", "profile": "Profile 1", "marker": marker}
        self.assertEqual(desktop.saved_window([window], state, "desktop-a", "Profile 1"), window)
        self.assertIsNone(desktop.saved_window([window], {**state, "marker": "Browser Control"},
                                              "desktop-a", "Profile 1"))
        self.assertFalse(desktop.bootstrap_title_matches("unrelated " + marker, marker))
        self.assertIsNone(desktop.saved_window([window], [], "desktop-a", "Profile 1"))

    def test_other_browsers_are_not_selected(self):
        clients = [{"class": "helium-browser"}, {"class": "ghostty"},
                   {"class": "org.chromium.Chromium", "mapped": True},
                   {"class": "chromium", "mapped": False}]
        self.assertEqual(desktop.chromium_windows(clients), [clients[2]])

    def test_extension_metadata_is_checked_without_changing_preferences(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            extension = root / "browser-control/extension/dist"
            extension.mkdir(parents=True)
            (extension / "manifest.json").write_text("{}")
            preferences = {"extensions": {"settings": {"id": {"path": str(extension)}}}}
            path = root / "Preferences"
            original = json.dumps(preferences)
            path.write_text(original)
            desktop.require_extension(root)
            self.assertEqual(path.read_text(), original)
            preferences["extensions"]["settings"]["id"]["disable_reasons"] = [1]
            path.write_text(json.dumps(preferences))
            with self.assertRaises(desktop.SetupError):
                desktop.require_extension(root)

    def test_unmanaged_chromium_fails_before_launch_or_service_changes(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            stack.enter_context(patch.object(Path, "home", return_value=Path(temp)))
            stack.enter_context(patch.object(desktop, "require_extension"))
            stack.enter_context(patch.object(desktop.shutil, "which", side_effect=lambda name: "/bin/" + name))
            stack.enter_context(patch.object(desktop, "json_run", side_effect=[
                [{"instance": "desktop-a"}], [{"class": "chromium", "address": "0xab", "pid": 123}]]))
            command = stack.enter_context(patch.object(desktop, "run"))
            with self.assertRaisesRegex(desktop.SetupError, "unmanaged"):
                desktop.bootstrap(argparse.Namespace(profile="Profile 1", workspace=3))
            command.assert_not_called()

    def test_connected_unmanaged_browser_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            stack.enter_context(patch.object(Path, "home", return_value=Path(temp)))
            stack.enter_context(patch.object(desktop, "require_extension"))
            stack.enter_context(patch.object(desktop.shutil, "which", side_effect=lambda name: "/bin/" + name))
            stack.enter_context(patch.object(desktop, "json_run", side_effect=[
                [{"instance": "desktop-a"}], [], {"extension": {"connected": True}}]))
            command = stack.enter_context(patch.object(desktop, "run"))
            with self.assertRaisesRegex(desktop.SetupError, "unmanaged browser/profile"):
                desktop.bootstrap(argparse.Namespace(profile="Profile 1", workspace=3))
            command.assert_not_called()

    def test_multiple_desktop_sessions_are_not_guessed(self):
        with patch.object(desktop, "json_run", return_value=[{}, {}]):
            with self.assertRaisesRegex(desktop.SetupError, "exactly one"):
                desktop.bootstrap(argparse.Namespace())


class DesktopBootstrapTests(unittest.TestCase):
    def test_cold_launch_records_marker_uses_lua_and_verifies_live_page(self):
        marker = "Browser Control bootstrap " + "a" * 32
        window = {"class": "chromium", "address": "0xab", "pid": 123,
                  "title": marker + " - Chromium", "workspace": {"id": 3}}
        status = {"relay": {"buildId": "build-a"}, "extension": {"connected": True},
                  "sessions": [{"id": "agent-test", "createdAt": "now", "readOnly": True}]}
        args = argparse.Namespace(profile="Profile 1", workspace=3, session="agent-test", timeout=5, read_only=True)
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            home = Path(temp)
            stack.enter_context(patch.object(Path, "home", return_value=home))
            stack.enter_context(patch.object(desktop, "require_extension"))
            stack.enter_context(patch.object(desktop.shutil, "which", side_effect=lambda name: "/bin/" + name))
            stack.enter_context(patch.object(desktop.uuid, "uuid4", return_value=SimpleNamespace(hex="a" * 32)))
            stack.enter_context(patch.object(desktop.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)))
            stack.enter_context(patch.object(desktop, "json_run", side_effect=[
                [{"instance": "desktop-a"}], [], {"extension": {"connected": False}},
                {"address": "0xterminal"}, [window],
                {**status, "sessions": []}, status, {"ok": True}, [window], {"address": "0xterminal"}, status]))
            def command(argv, **kwargs):
                if "dispatch" in argv:
                    pending = json.loads((home / ".local/state/browser-workspace/window.json").read_text())
                    self.assertEqual(pending["marker"], marker)
                return "ok"
            calls = stack.enter_context(patch.object(desktop, "run", side_effect=command))
            receipt = desktop.bootstrap(args)
            self.assertTrue(receipt["created_window"])
            self.assertEqual(receipt["workspace"], 3)
            launch = calls.call_args_list[0].args[0]
            self.assertEqual(launch[-2], "dispatch")
            self.assertIn("hl.dsp.exec_cmd(", launch[-1])
            self.assertIn('workspace = "3 silent"', launch[-1])
            self.assertIn("--profile-directory=", launch[-1])
            self.assertIn("--read-only", calls.call_args_list[1].args[0])
            self.assertEqual(calls.call_args_list[1].kwargs["env"]["BROWSER_CONTROL_AUTOSTART"], "true")
            state = json.loads((home / ".local/state/browser-workspace/window.json").read_text())
            self.assertEqual(state["address"], "0xab")
            self.assertEqual(state["pid"], 123)

    def test_reuse_moves_only_recorded_window_with_lua_without_new_session(self):
        window = {"class": "chromium", "address": "0xab", "pid": 123, "workspace": {"id": 2}}
        moved = {**window, "workspace": {"id": 3}}
        status = {"relay": {"buildId": "build-a"}, "extension": {"connected": True},
                  "sessions": [{"id": "agent-test", "createdAt": "now"}]}
        args = argparse.Namespace(profile="Profile 1", workspace=3, session="agent-test", timeout=5, read_only=False)
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            home = Path(temp)
            state_path = home / ".local/state/browser-workspace/window.json"
            state_path.parent.mkdir(parents=True)
            desktop.save_state(state_path, {"instance": "desktop-a", "profile": "Profile 1", "address": "0xab", "pid": 123})
            stack.enter_context(patch.object(Path, "home", return_value=home))
            stack.enter_context(patch.object(desktop, "require_extension"))
            stack.enter_context(patch.object(desktop.shutil, "which", side_effect=lambda name: "/bin/" + name))
            stack.enter_context(patch.object(desktop.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)))
            stack.enter_context(patch.object(desktop, "json_run", side_effect=[
                [{"instance": "desktop-a"}], [window], status, {"address": "0xterminal"},
                status, status, {"ok": True}, [moved], {"address": "0xterminal"}, status]))
            calls = stack.enter_context(patch.object(desktop, "run", return_value="ok"))
            receipt = desktop.bootstrap(args)
            self.assertFalse(receipt["created_window"])
            calls.assert_called_once()
            self.assertEqual(calls.call_args.args[0][-1],
                             'hl.dsp.window.move({window = "address:0xab", workspace = "3", follow = false})')


class TunnelTests(unittest.TestCase):
    def test_active_mapping_is_not_toggled_off(self):
        with patch.object(client, "api", return_value={"connected": True, "reverse_tunnels": [tunnel()]}) as api:
            client.ensure_tunnel(5)
        self.assertTrue(all(not call.kwargs.get("post") for call in api.call_args_list))

    def test_missing_mapping_is_enabled_exactly_once(self):
        with patch.object(client, "api", side_effect=[
            {"connected": True, "reverse_tunnels": []}, None,
            {"connected": True, "reverse_tunnels": [tunnel()]}]) as api:
            client.ensure_tunnel(5)
        self.assertEqual(api.call_args_list[1].args, ("/api/reverse/19989/19989/toggle",))
        self.assertEqual(api.call_args_list[1].kwargs, {"post": True})

    def test_pending_mapping_is_waited_for_not_toggled(self):
        with patch.object(client, "api", side_effect=[
            {"connected": True, "reverse_tunnels": [tunnel(state="pending")]},
            {"connected": True, "reverse_tunnels": [tunnel()]}]) as api:
            client.ensure_tunnel(5)
        self.assertTrue(all(not call.kwargs.get("post") for call in api.call_args_list))

    def test_conflicting_mapping_is_not_replaced(self):
        with patch.object(client, "api", return_value={"connected": True, "reverse_tunnels": [tunnel(20000)]}) as api:
            with self.assertRaisesRegex(desktop.SetupError, "already maps elsewhere"):
                client.ensure_tunnel(5)
        self.assertEqual(api.call_count, 1)

    def test_url_uses_actual_desktop_port_and_preserves_components(self):
        status = {"connected": True, "tunnels": [{"remote_port": 5173, "local_port": 5174, "state": "active"}]}
        for hostname in ("localhost", "127.0.0.1", "[::1]"):
            self.assertEqual(client.mapped_url(f"http://{hostname}:5173/path?q=1#section", status),
                             "http://127.0.0.1:5174/path?q=1#section")
        for url in ("https://example.com", "file:///etc/passwd", "http://localhost:9999", "http://a:b@localhost:5173"):
            with self.subTest(url=url), self.assertRaises(desktop.SetupError):
                client.mapped_url(url, status)

    def test_wrong_desktop_and_disconnected_extension_are_rejected(self):
        receipt = {"relay_build": "build-a", "session": "agent-123", "session_created_at": "now"}
        status = {"relay": {"buildId": "build-a"}, "extension": {"connected": True},
                  "sessions": [{"id": "agent-123", "createdAt": "now"}]}
        client.verify_forwarded_relay(status, receipt)
        for change in ({"relay": {"buildId": "build-b"}}, {"sessions": []},
                       {"extension": {"connected": False}}, {"relay": {"buildId": "build-a", "stale": True}}):
            with self.subTest(change=change), self.assertRaises(desktop.SetupError):
                client.verify_forwarded_relay({**status, **change}, receipt)

    def test_client_uses_strict_ssh_and_never_autostarts_local_relay(self):
        receipt = {"relay_build": "build-a", "session": "agent-123", "session_created_at": "now"}
        status = {"relay": {"buildId": "build-a"}, "extension": {"connected": True},
                  "sessions": [{"id": "agent-123", "createdAt": "now"}]}
        args = argparse.Namespace(desktop="odysseas@omarchy-mac", workspace=3, profile="Profile 1",
                                  session="agent-123", timeout=5, read_only=False)
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            stack.enter_context(patch.object(Path, "home", return_value=Path(temp)))
            ssh = stack.enter_context(patch.object(client.subprocess, "run", return_value=
                subprocess.CompletedProcess([], 0, json.dumps(receipt), "")))
            stack.enter_context(patch.object(client, "ensure_tunnel"))
            cli = stack.enter_context(patch.object(client, "json_run", side_effect=[status, {"ok": True}]))
            self.assertTrue(client.ensure(args)["ready"])
            self.assertIn("StrictHostKeyChecking=yes", ssh.call_args.args[0])
            self.assertIn("BatchMode=yes", ssh.call_args.args[0])
            self.assertIn("--profile 'Profile 1'", ssh.call_args.args[0][-1])
            for call in cli.call_args_list:
                self.assertEqual(call.kwargs["env"]["BROWSER_CONTROL_AUTOSTART"], "false")


if __name__ == "__main__":
    unittest.main()
