import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher, ui, installer = (load(name) for name in ("launch", "ui", "install"))


def tree(prefix="debina/"):
    return {"spaces": [{"id": prefix + "sp1", "machine": "debina" if prefix else None,
        "tabs": [{"id": prefix + "tb1", "terminals": [{"terminal": prefix + "t7", "pane": prefix + "p1"}]}]}]}


class SharedPiTests(unittest.TestCase):
    def test_alias_is_ordinary_pi_no_client_or_discovery_restrictions(self):
        command = launcher.command(["--app-client", "windows", "--continue", "--", "--app-client=prompt"])
        self.assertEqual(command, [str(Path.home() / ".pi/agent/bin/pi"), "--continue", "--", "--app-client=prompt"])
        self.assertNotIn("--no-extensions", launcher.command([]))
        self.assertIn("/old/session.jsonl", launcher.command(["--session", "/old/session.jsonl"]))

    def test_alias_only_removes_retired_profile_overrides(self):
        retired = str(Path.home() / ".pi/profiles/herdr-app")
        env = launcher.clean_environment({"PI_CODING_AGENT_DIR": retired, "PI_CODING_AGENT_SESSION_DIR": retired + "/sessions/x",
            "PI_APP_CLIENT": "windows", "HC_TERMINAL_ID": "t7", "HERDR_ENV": "1", "PATH": "/bin"})
        self.assertNotIn("PI_CODING_AGENT_DIR", env)
        self.assertNotIn("PI_CODING_AGENT_SESSION_DIR", env)
        self.assertNotIn("PI_APP_CLIENT", env)
        self.assertEqual(env["HC_TERMINAL_ID"], "t7")
        self.assertEqual(env["HERDR_ENV"], "1")
        self.assertEqual(launcher.clean_environment({"PI_CODING_AGENT_DIR": "/custom"})["PI_CODING_AGENT_DIR"], "/custom")

    def test_installer_never_creates_profile_or_changes_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            old = home / ".pi/agent"
            old.mkdir(parents=True)
            for name in ("auth.json", "settings.json"):
                (old / name).write_text('{"marker":"existing"}')
            before = {str(p): p.read_bytes() for p in old.rglob("*") if p.is_file()}
            installer.install(home)
            installer.install(home, packages=True)
            self.assertFalse((home / ".pi/profiles").exists())
            self.assertEqual(before, {str(p): p.read_bytes() for p in old.rglob("*") if p.is_file() and p.name != "herdr-app.ts"})
            self.assertTrue((old / "extensions/herdr-app.ts").is_symlink())
            self.assertTrue((home / ".local/bin/herdr-ui").is_symlink())


class UITests(unittest.TestCase):
    def setUp(self):
        self.config = {"clients": {"omarchy": {"platform": "linux"}, "windows": {"platform": "windows"}}}
        self.online = {name: {"target": target, "tree": tree()} for name, target in self.config["clients"].items()}

    def test_explicit_targets_and_destructive_permission(self):
        for name, values in (("tab.new", {"name": "Review"}), ("pane.split", {"direction": "right"}),
                             ("pane.focus", {}), ("space.new", {"name": "API"}),
                             ("layout.switch", {}), ("pane.close", {"pane": "p1"}),
                             ("app.update_core", {}), ("app.quit", {}), ("pane.focus", {"pane": 42})):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ui.validate_command(name, values)
        self.assertTrue(ui.validate_command("tab.close", {"id": "debina/tb1"}, True)["confirmed"])

    def test_linux_transport_roundtrip_no_shell_interpolation(self):
        import shlex
        values = {"name": 'quotes " Ω ; $(touch /bad)', "space": "debina/sp1", "argv": ["pi"]}
        request = {"argv": ["do", "tab.new", json.dumps(values, ensure_ascii=False)]}
        argv = shlex.split(ui.remote_command({"platform": "linux"}, request))
        self.assertEqual(argv[:2], ["python3", "-c"])
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, b'{}', b'')) as run:
            exec(argv[2])
        self.assertEqual(run.call_args.args[0][1:], request["argv"])

    def test_windows_native_arguments_preserve_json(self):
        request = {"argv": ["do", "tab.new", '{"name":"quotes \\" Ω","space":"debina/sp1"}']}
        script = ui.windows_script(request)
        self.assertIn(base64.b64encode(subprocess.list2cmdline(request["argv"]).encode()).decode(), script)
        self.assertNotIn("& $", script)

    def test_discovery_skips_offline_and_other_machine_spaces(self):
        def decoded(target, argv):
            if target["platform"] == "windows":
                raise ValueError("offline")
            return {"spaces": tree()["spaces"] + [{"id": "local", "machine": None}]}
        with patch.object(ui, "decoded", side_effect=decoded):
            online, offline = ui.discover(self.config)
        self.assertEqual(list(online), ["omarchy"])
        self.assertEqual(len(online["omarchy"]["tree"]["spaces"]), 1)
        self.assertIn("windows", offline)

    def test_current_does_not_depend_on_focused_desktop(self):
        with patch.dict(os.environ, {"HC_TERMINAL_ID": "t7"}), patch.object(ui, "discover", return_value=(self.online, {})):
            self.assertEqual(ui.automatic(self.config, "current")["tab"], "debina/tb1")

    def test_shared_creation_once_then_mirrors_focus_not_creation(self):
        calls = []
        def decoded(target, argv):
            calls.append((target["platform"], argv))
            return {"tab": "debina/tb2", "terminal": "debina/t8"} if argv[1] == "tab.new" else {}
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "wait_visible") as wait, patch.object(ui, "decoded", side_effect=decoded):
            result = ui.automatic(self.config, "do", "tab.new", {"space": "sp1", "name": "Review"})
        self.assertEqual([argv[1] for _, argv in calls], ["tab.new", "pane.focus"])
        self.assertEqual(json.loads(calls[0][1][2])["space"], "debina/sp1")
        self.assertEqual(result["_routing"]["applied"], ["omarchy", "windows"])
        wait.assert_called_once()

    def test_focus_mirrors_to_every_screen_without_client_selection(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "decoded", return_value={}) as call:
            ui.automatic(self.config, "do", "pane.focus", {"terminal": "t7"})
        self.assertEqual(call.call_count, 2)
        for args in call.call_args_list:
            self.assertEqual(json.loads(args.args[1][2])["terminal"], "debina/t7")

    def test_layout_block_ids_are_not_machine_qualified(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "decoded", return_value={}) as call:
            ui.automatic(self.config, "do", "layout.show", {"id": "files"})
        self.assertEqual(call.call_count, 2)
        self.assertEqual(json.loads(call.call_args.args[1][2])["id"], "files")

    def test_local_debina_strips_remote_prefix(self):
        self.assertEqual(ui.target_args({"terminal": "debina/t7"}, {"transport": "local"}, "pane.focus"), {"terminal": "t7"})
        with self.assertRaises(ValueError):
            ui.target_args({"terminal": "other/t7"}, {}, "pane.focus")

    def test_mutation_failure_is_never_retried_on_another_screen(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "decoded", side_effect=ValueError("lost acknowledgment")) as call:
            with self.assertRaisesRegex(ValueError, "lost acknowledgment"):
                ui.automatic(self.config, "do", "tab.new", {"space": "sp1", "name": "X"})
        self.assertEqual(call.call_count, 1)

    def test_partial_mirror_success_does_not_invite_duplicate_creation(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "wait_visible"), patch.object(ui, "decoded", side_effect=[{"terminal": "debina/t8"}, ValueError("closed")]) as call:
            result = ui.automatic(self.config, "do", "tab.new", {"space": "sp1", "name": "X"})
        self.assertEqual(call.call_count, 2)
        self.assertEqual(result["terminal"], "debina/t8")
        self.assertIn("windows", result["_routing"]["view_errors"])

    def test_all_offline_reports_error_without_launching(self):
        with patch.object(ui, "discover", return_value=({}, {"windows": "offline"})), patch.object(ui, "invoke") as invoke:
            with self.assertRaisesRegex(ValueError, "No reachable"):
                ui.automatic(self.config, "ls")
        invoke.assert_not_called()

    def test_invalid_mutation_is_rejected_before_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "clients.json"
            config.write_text(json.dumps(self.config))
            with patch("sys.argv", ["herdr-ui", "--config", str(config), "do", "pane.close", '{"pane":"p1"}']), patch.object(ui, "discover") as discover:
                with self.assertRaises(ValueError):
                    ui.main()
            discover.assert_not_called()

    def test_private_core_is_rejected_before_a_window_is_contacted(self):
        with patch.dict(os.environ, {"HC_TERMINAL_SOCKET": "/tmp/private/core.sock", "HC_SESSION": "private"}), patch.object(ui, "core_rpc") as rpc:
            with self.assertRaisesRegex(ValueError, "different/private core"):
                ui.check_core({"core": {"socket": "/real/default.sock", "id": "expected"}})
        rpc.assert_not_called()

    def test_core_identity_mismatch_fails_closed(self):
        with patch.dict(os.environ, {"HC_TERMINAL_SOCKET": "/real/default.sock", "HC_SESSION": "default"}), patch.object(ui, "core_rpc", return_value={"core": {"id": "wrong"}}):
            with self.assertRaisesRegex(ValueError, "identity changed"):
                ui.check_core({"core": {"socket": "/real/default.sock", "id": "expected"}})

    def test_shared_resize_is_qualified_and_issued_only_once(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "shared_ids", return_value={"p1"}), patch.object(ui, "decoded", return_value={}) as call:
            ui.automatic(self.config, "do", "layout.resize", {"id": "p1", "weight": .5})
        self.assertEqual(call.call_count, 1)
        self.assertEqual(json.loads(call.call_args.args[1][2])["id"], "debina/p1")

    def test_chrome_resize_is_unqualified_and_mirrored(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "shared_ids", return_value=set()), patch.object(ui, "decoded", return_value={}) as call:
            ui.automatic(self.config, "do", "layout.resize", {"id": "files", "px": 250})
        self.assertEqual(call.call_count, 2)
        self.assertEqual(json.loads(call.call_args.args[1][2])["id"], "files")

    def test_pane_less_worker_is_peeked_without_creating_a_process(self):
        with patch.object(ui, "discover", return_value=(self.online, {})), patch.object(ui, "decoded", return_value={}) as call:
            ui.automatic(self.config, "do", "pane.focus", {"terminal": "t9"})
        self.assertEqual(call.call_count, 2)
        self.assertTrue(all(c.args[1][1] == "terminal.peek" for c in call.call_args_list))

    def test_transport_does_not_weaken_ssh_or_retry(self):
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 255, b"", b"offline")) as run:
            with self.assertRaisesRegex(ValueError, "offline"):
                ui.invoke({"host": "user@box", "platform": "linux"}, {"argv": ["status"]})
        self.assertEqual(run.call_count, 1)
        self.assertIn("StrictHostKeyChecking=yes", run.call_args.args[0])
        self.assertIn("BatchMode=yes", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
