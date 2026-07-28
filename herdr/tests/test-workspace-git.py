#!/usr/bin/env python3

import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / ".local" / "bin" / "workspace-git"
loader = importlib.machinery.SourceFileLoader("workspace_git", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
workspace_git = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = workspace_git
loader.exec_module(workspace_git)


def init_repository(path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "Test"], check=True)
    (path / "tracked.txt").write_text("initial\n")
    subprocess.run(["git", "-C", str(path), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)


class WorkspaceGitTests(unittest.TestCase):
    def test_discovers_only_immediate_child_repositories(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            first = workspace / "first"
            second = workspace / "second"
            nested = workspace / "group" / "nested"
            first.mkdir()
            second.mkdir()
            nested.mkdir(parents=True)
            init_repository(first)
            init_repository(second)
            init_repository(nested)

            root, repositories = workspace_git.discover(workspace)
            self.assertEqual(root, workspace.resolve())
            self.assertEqual(repositories, [first.resolve(), second.resolve()])

    def test_direct_repository_skips_workspace_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            child = repository / "src"
            child.mkdir(parents=True)
            init_repository(repository)
            root, repositories = workspace_git.discover(child)
            self.assertEqual(root, repository.resolve())
            self.assertEqual(repositories, [repository.resolve()])

    def test_reports_worktree_and_index_state(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            repository.mkdir()
            init_repository(repository)
            (repository / "tracked.txt").write_text("modified\n")
            (repository / "staged.txt").write_text("staged\n")
            (repository / "untracked.txt").write_text("untracked\n")
            subprocess.run(["git", "-C", str(repository), "add", "staged.txt"], check=True)

            status = workspace_git.repository_status(repository)
            self.assertEqual(status.modified, 1)
            self.assertEqual(status.staged, 1)
            self.assertEqual(status.untracked, 1)
            self.assertEqual(status.conflicted, 0)
            self.assertEqual(status.additions, 2)
            self.assertEqual(status.deletions, 1)


if __name__ == "__main__":
    unittest.main()
