import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "shell/.local/bin/pi-packages"
MOCK_PI = '''#!/usr/bin/env python3
import json, os, pathlib, sys
agent = pathlib.Path(os.environ['PI_CODING_AGENT_DIR'])
action, source = sys.argv[1:]
with open(os.environ['TRACE'], 'a') as stream:
    stream.write(json.dumps([action, source]) + '\\n')
if os.environ.get('FAIL_SOURCE') == source:
    sys.exit(7)
name = source[4:].rsplit('@', 1)[0] if '@' in source[5:] else source[4:]
p = agent / 'settings.json'
data = json.loads(p.read_text()) if p.exists() else {}
def identity(entry):
    value = entry['source'] if isinstance(entry, dict) else entry
    return value[4:].rsplit('@', 1)[0] if value.startswith('npm:') and '@' in value[5:] else value[4:] if value.startswith('npm:') else value
packages = data.setdefault('packages', [])
if action == 'remove':
    data['packages'] = [entry for entry in packages if identity(entry) != name]
    shutil_path = agent / 'npm/node_modules' / name
    import shutil
    shutil.rmtree(shutil_path, ignore_errors=True)
elif action == 'install':
    for index, entry in enumerate(packages):
        if identity(entry) == name:
            packages[index] = dict(entry, source=source) if isinstance(entry, dict) else source
            break
    else:
        packages.append(source)
    installed = agent / 'npm/node_modules' / name / 'package.json'
    installed.parent.mkdir(parents=True, exist_ok=True)
    installed.write_text('{}')
else:
    sys.exit(9)
p.write_text(json.dumps(data))
'''


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.agent = self.home / ".pi/agent"
        self.agent.mkdir(parents=True)
        self.settings = self.agent / "settings.json"
        self.manifest = self.root / "packages.json"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        mock = self.bin / "pi"
        mock.write_text(MOCK_PI)
        mock.chmod(0o755)
        self.trace = self.root / "trace"
        self.env = dict(os.environ, HOME=str(self.home), PI_CODING_AGENT_DIR=str(self.agent),
                        TRACE=str(self.trace), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.desired(["npm:keep"])
        self.configure([])

    def desired(self, packages):
        self.manifest.write_text(json.dumps({"schema": 1, "packages": packages}))

    def configure(self, packages):
        self.original = {"deviceId": "private-machine", "packages": packages,
                         "extensions": ["local.ts"], "mcp": {"private": "untouched"}, "theme": "mine"}
        self.settings.write_text(json.dumps(self.original, indent=4) + "\n")

    def installed(self, name):
        path = self.agent / "npm/node_modules" / name / "package.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}")

    def run_sync(self, *args, expected=0):
        result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(self.manifest), *args],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.trace.read_text().splitlines()] if self.trace.exists() else []

    def test_install_remove_preserve_private_settings_and_backup(self):
        self.configure(["npm:keep", "npm:@juicesharp/rpiv-todo", "npm:@ogulcancelik/pi-codex-compaction",
                        "git:github.com/example/local", "/local/extension"])
        before = self.settings.read_bytes()
        self.run_sync()
        self.assertEqual(self.calls(), [["install", "npm:keep"], ["remove", "npm:@juicesharp/rpiv-todo"],
                                      ["remove", "npm:@ogulcancelik/pi-codex-compaction"]])
        data = json.loads(self.settings.read_text())
        self.assertEqual(data.pop("packages"), ["npm:keep", "git:github.com/example/local", "/local/extension"])
        self.assertEqual(data, {k: v for k, v in self.original.items() if k != "packages"})
        backups = list((self.agent / "dotfiles-package-backups").glob("*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_idempotent_and_preserves_resource_filters(self):
        self.configure([{"source": "npm:keep", "extensions": ["!disabled.ts"]}])
        self.installed("keep")
        before = self.settings.read_bytes()
        self.run_sync()
        self.run_sync("--check")
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.agent / "dotfiles-package-backups").exists())

    def test_version_change_uses_install_not_remove(self):
        self.configure([{"source": "npm:@scope/keep@1.0.0", "skills": []}])
        self.desired(["npm:@scope/keep@2.0.0"])
        self.run_sync()
        self.assertEqual(self.calls(), [["install", "npm:@scope/keep@2.0.0"]])
        self.assertEqual(json.loads(self.settings.read_text())["packages"],
                         [{"source": "npm:@scope/keep@2.0.0", "skills": []}])

    def test_check_has_no_side_effects(self):
        before = self.settings.read_bytes()
        self.run_sync("--check", expected=1)
        self.assertEqual(before, self.settings.read_bytes())
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.agent / ".dotfiles-packages.lock").exists())

    def test_failed_install_stops_before_removals(self):
        self.configure(["npm:retired"])
        self.env["FAIL_SOURCE"] = "npm:keep"
        before = self.settings.read_bytes()
        self.run_sync(expected=1)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertEqual(self.calls(), [["install", "npm:keep"]])

    def test_invalid_or_duplicate_manifest_rejected_before_mutation(self):
        for packages in [["git:github.com/invalid"], ["npm:keep", "npm:keep@2"], [None]]:
            with self.subTest(packages=packages):
                self.desired(packages)
                self.run_sync(expected=1)
                self.assertEqual(self.calls(), [])
                self.assertFalse((self.agent / ".dotfiles-packages.lock").exists())

    def test_empty_list_removes_only_npm_packages(self):
        self.desired([])
        self.configure(["npm:old", {"source": "../local", "skills": []}])
        self.run_sync()
        self.assertEqual(self.calls(), [["remove", "npm:old"]])
        self.assertEqual(json.loads(self.settings.read_text())["packages"], [{"source": "../local", "skills": []}])

    def test_bad_settings_and_symlinks_refused(self):
        self.settings.write_text('{"packages":{}}')
        self.run_sync(expected=1)
        self.settings.unlink()
        self.settings.symlink_to(self.manifest)
        before = self.manifest.read_bytes()
        self.run_sync(expected=1)
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(self.calls(), [])

    def test_folded_agent_symlink_cannot_modify_repo_template(self):
        repo = self.root / "repo"
        executable_dir = repo / "shell/.local/bin"
        executable_dir.mkdir(parents=True)
        shutil.copy2(SCRIPT, executable_dir / "pi-packages")
        template_dir = repo / "pi/.pi/agent"
        template_dir.mkdir(parents=True)
        template = template_dir / "settings.json"
        before = self.settings.read_bytes()
        template.write_bytes(before)
        shutil.rmtree(self.agent)
        self.agent.symlink_to(template_dir)
        result = subprocess.run([sys.executable, str(executable_dir / "pi-packages"),
                                 "--manifest", str(self.manifest)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("repo-backed", result.stderr)
        self.assertEqual(template.read_bytes(), before)
        self.assertEqual(self.calls(), [])

    def test_missing_pi_fails_without_settings_changes(self):
        (self.bin / "pi").unlink()
        self.env["PATH"] = str(self.bin)
        before = self.settings.read_bytes()
        self.run_sync(expected=1)
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertFalse((self.agent / "dotfiles-package-backups").exists())

    def test_fresh_settings(self):
        self.settings.unlink()
        self.run_sync()
        self.assertEqual(json.loads(self.settings.read_text()), {"packages": ["npm:keep"]})

    def test_packages_only_does_not_pull_or_localize_or_bootstrap(self):
        repo = self.root / "repo"
        executable_dir = repo / "shell/.local/bin"
        executable_dir.mkdir(parents=True)
        for name in ["dot", "pi-packages"]:
            shutil.copy2(ROOT / "shell/.local/bin" / name, executable_dir / name)
        (repo / "pi").mkdir()
        shutil.copy2(self.manifest, repo / "pi/packages.json")
        git = self.bin / "git"
        git.write_text('#!/bin/sh\ncase "$*" in\n*"rev-parse --show-toplevel") printf "%s\\n" "$TEST_REPO" ;;\n*) exit 99 ;;\nesac\n')
        git.chmod(0o755)
        self.env["TEST_REPO"] = str(repo)
        result = subprocess.run(["bash", str(executable_dir / "dot"), "--packages-only"],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls(), [["install", "npm:keep"]])
        self.assertFalse((self.home / ".config/fish").exists())


if __name__ == "__main__":
    unittest.main()
