import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/luca-ticket"


class TicketEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.luca = root / "Luca"
        self.config = root / "local.env"
        self.config.write_text("MYSQL_USER=local_test_user\nMYSQL_PASSWORD=not-a-real-secret\nMYSQL_PORT=3307\n")
        self.log = root / "commands.jsonl"
        fake = root / "fake-tool.py"
        fake.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps({'argv': sys.argv[1:], 'db': os.getenv('DB_DATABASE'),
                        'url': os.getenv('DB_URL'), 'host': os.getenv('DB_HOST')})+'\\n')
""")
        fake.chmod(0o700)
        self.env = {**os.environ, "LUCA_ROOT": str(self.luca), "LUCA_LOCAL_ENV": str(self.config),
                    "LUCA_MYSQL_BIN": str(fake), "LUCA_PHP_BIN": str(fake), "FAKE_LOG": str(self.log)}
        self.ticket = self.luca / ".ticket-worktrees/LHD-123"
        for repo in ("luca-backend", "luca-ims"):
            path = self.ticket / repo
            path.mkdir(parents=True)
            (path / ".git").write_text("gitdir: fixture\n")

    def run_cli(self, *args, ok=True):
        process = subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                                 capture_output=True, text=True)
        if ok:
            self.assertEqual(process.returncode, 0, process.stderr)
        else:
            self.assertNotEqual(process.returncode, 0)
        return process

    def test_setup_repeatable_test_isolated_and_status_non_secret(self):
        self.run_cli("setup", "LHD-123", "--repos", "backend,ims")
        state = json.loads((self.ticket / ".luca-env.json").read_text())
        backend = self.ticket / "luca-backend/.env"
        ims = self.ticket / "luca-ims/.env.local"
        first_env = backend.read_text()
        self.assertIn(f'VITE_API_URL=http://127.0.0.1:{state["backend_port"]}', ims.read_text())
        self.assertIn(state["dev_db"], first_env)
        self.assertNotIn(state["test_db"], first_env)
        self.assertEqual(backend.stat().st_mode & 0o777, 0o600)
        self.run_cli("setup", "LHD-123", "--repos", "backend,ims")
        self.assertEqual(backend.read_text(), first_env)  # APP_KEY remains stable
        status = self.run_cli("status", "LHD-123").stdout
        self.assertIn(state["test_db"], status)
        self.assertNotIn("not-a-real-secret", status)
        self.run_cli("test", "LHD-123", "backend", "--", "--parallel")
        records = [json.loads(line) for line in self.log.read_text().splitlines()]
        php = records[-2:]
        self.assertEqual(php[0]["db"], state["test_db"])
        self.assertEqual(php[1]["db"], state["test_db"])
        self.assertEqual(php[0]["host"], "127.0.0.1")
        self.assertEqual(php[0]["url"], "")
        self.assertEqual(php[1]["argv"], ["artisan", "test", "--parallel"])

    def test_existing_unmanaged_env_is_preserved(self):
        original = self.ticket / "luca-backend/.env"
        original.write_text("USER_OWNED=true\n")
        result = self.run_cli("setup", "LHD-123", "--repos", "backend", ok=False)
        self.assertIn("left untouched", result.stderr)
        self.assertEqual(original.read_text(), "USER_OWNED=true\n")

    def test_invalid_ticket_and_cached_config_refuse_tests(self):
        self.run_cli("setup", "../escape", "--repos", "backend", ok=False)
        self.run_cli("setup", "LHD-123", "--repos", "backend")
        cache = self.ticket / "luca-backend/bootstrap/cache"
        cache.mkdir(parents=True)
        (cache / "config.php").write_text("cached")
        self.assertIn("cached Laravel config", self.run_cli("test", "LHD-123", "backend", ok=False).stderr)

    def test_ims_setup_does_not_need_mysql_credentials(self):
        self.config.unlink()
        self.run_cli("setup", "LHD-123", "--repos", "ims")
        self.assertIn("VITE_API_URL", (self.ticket / "luca-ims/.env.local").read_text())


if __name__ == "__main__":
    unittest.main()
