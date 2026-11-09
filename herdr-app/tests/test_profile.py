import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('profile_sync', Path(__file__).parents[1] / 'profile.py')
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'keys.json').write_text('{"global": {"ctrl-space c": "tab.new"}}\n')
        (self.source / 'settings.json').write_text('{"zoom": 1}\n')
        self.home, self.state = self.root / 'home', self.root / 'state'

    def test_sync_is_idempotent_and_preserves_runtime(self):
        payload = profile.export_profile(self.source)
        first = profile.apply_profile(payload, self.home, self.state)
        self.assertEqual(len(first['changed']), 2)
        (self.home / 'view.json').write_text('{"focus": "local"}')
        (self.home / 'shared.json').write_text('{"layout": "local"}')
        self.assertEqual(profile.apply_profile(payload, self.home, self.state)['changed'], [])
        self.assertEqual(json.loads((self.home / 'view.json').read_text()), {'focus': 'local'})
        self.assertEqual(json.loads((self.home / 'shared.json').read_text()), {'layout': 'local'})

    def test_changed_preferences_are_backed_up(self):
        payload = profile.export_profile(self.source)
        profile.apply_profile(payload, self.home, self.state)
        (self.home / 'settings.json').write_text('{"zoom": 2}')
        profile.apply_profile(payload, self.home, self.state)
        saved = list((self.state / 'backups').rglob('settings.json'))
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0].read_text(), '{"zoom": 2}')

    def test_runtime_and_path_traversal_rejected(self):
        for name in ['view.json', 'shared.json', '../keys.json', '/keys.json',
                     'layouts/.state/odysseas.json', 'mods/main/main.js',
                     'mods/odysseas-nav/../main.js', 'C:\\keys.json']:
            self.assertFalse(profile.allowed(name), name)

    def test_entire_payload_checked_before_writing(self):
        payload = profile.export_profile(self.source)
        payload['files'][-1]['content'] = base64.b64encode(b'bad').decode()
        with self.assertRaises(ValueError):
            profile.apply_profile(payload, self.home, self.state)
        self.assertFalse(self.home.exists())

    def test_duplicate_and_incomplete_profile_rejected(self):
        payload = profile.export_profile(self.source)
        with self.assertRaises(ValueError):
            profile.validate({'schema': 1, 'files': [payload['files'][0]]})
        payload['files'].append(payload['files'][0])
        with self.assertRaises(ValueError):
            profile.validate(payload)

    def test_symlink_cannot_escape_destination(self):
        outside = self.root / 'outside'
        outside.mkdir()
        self.home.mkdir()
        (self.home / 'settings.json').symlink_to(outside / 'settings.json')
        with self.assertRaises(ValueError):
            profile.apply_profile(profile.export_profile(self.source), self.home, self.state)
        self.assertFalse((outside / 'settings.json').exists())

    def test_real_profile_is_valid(self):
        decoded = profile.validate(profile.export_profile(Path(__file__).parents[1] / 'profile'))
        keys = json.loads(decoded['keys.json'])
        self.assertEqual(keys['global']['ctrl-space c'], 'tab.new')
        self.assertEqual(keys['global']['ctrl-space ctrl-space'], 'send:\x00')
        self.assertEqual(keys['layout:odysseas']['ctrl-space'], 'odysseas-nav.prefix')
        self.assertEqual(keys['mod:odysseas-nav']['c'], 'odysseas-nav.key:tab.new')
        self.assertEqual(keys['mod:odysseas-nav']['ctrl-space'], 'odysseas-nav.key:literal-prefix')
        self.assertIn('mods/odysseas-nav/main.js', decoded)


if __name__ == '__main__':
    unittest.main()
