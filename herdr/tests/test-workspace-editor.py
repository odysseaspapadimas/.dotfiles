#!/usr/bin/env python3

import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / ".local" / "bin" / "workspace-editor"
loader = importlib.machinery.SourceFileLoader("workspace_editor", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
workspace_editor = importlib.util.module_from_spec(spec)
loader.exec_module(workspace_editor)


class WorkspaceEditorTests(unittest.TestCase):
    def test_parse_location(self):
        self.assertEqual(workspace_editor.parse_location("src/main.rs:42"), (Path("src/main.rs"), 42))
        self.assertEqual(workspace_editor.parse_location("README.md"), (Path("README.md"), None))
        self.assertEqual(workspace_editor.parse_location("name:part"), (Path("name:part"), None))

    def test_project_root_and_bounded_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            nested = root / "src"
            nested.mkdir()
            target = nested / "main.rs"
            target.write_text("fn main() {}\n")
            self.assertEqual(workspace_editor.project_root(nested), root.resolve())
            self.assertEqual(
                workspace_editor.resolve_target(root, nested, "main.rs:7"),
                (target.resolve(), 7),
            )
            outside = root.parent / "outside.rs"
            outside.write_text("outside\n")
            try:
                with self.assertRaises(workspace_editor.EditorError):
                    workspace_editor.resolve_target(root, nested, "../../outside.rs")
            finally:
                outside.unlink()

    def test_identity_is_stable_and_mode_specific(self):
        first = workspace_editor.short_hash("session", "w1", "/project", "tab")
        second = workspace_editor.short_hash("session", "w1", "/project", "tab")
        split = workspace_editor.short_hash("session", "w1", "/project", "split")
        self.assertEqual(first, second)
        self.assertNotEqual(first, split)

    def test_shell_is_idle_but_replaced_shell_process_is_not(self):
        shell = {"shell_pid": 10, "foreground_processes": [{"pid": 10, "name": "zsh"}]}
        editor = {"shell_pid": 10, "foreground_processes": [{"pid": 10, "name": "nvim"}]}
        child = {
            "shell_pid": 10,
            "foreground_processes": [
                {"pid": 10, "name": "zsh"},
                {"pid": 11, "name": "nvim"},
            ],
        }
        self.assertEqual(workspace_editor.active_foreground_processes(shell), [])
        self.assertEqual(len(workspace_editor.active_foreground_processes(editor)), 1)
        self.assertEqual(len(workspace_editor.active_foreground_processes(child)), 1)


if __name__ == "__main__":
    unittest.main()
