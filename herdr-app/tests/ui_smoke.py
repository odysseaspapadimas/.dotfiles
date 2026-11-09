#!/usr/bin/env python3
"""Exercise real prefix keys in a private Xvfb display and private hc session."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from portd_fixture import PortdFixture

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('profile_sync', ROOT / 'profile.py')
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


def main():
    root = Path(tempfile.mkdtemp(prefix='herdr-ui-'))
    layout = os.environ.get('HERDR_TEST_LAYOUT', 'odysseas')
    env = {k: v for k, v in os.environ.items() if not k.startswith('HC_')}
    env.update(HC_SESSION='profile-test', HERDR_APP_HOME=str(root / 'app'),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_STATE_HOME=str(root / 'state'),
               XDG_RUNTIME_DIR=str(root / 'run'), WAYLAND_DISPLAY='',
               HERDR_APP_NO_SOUND='1', DO_NOT_TRACK='1')
    (root / 'run').mkdir(mode=0o700)
    app = str(Path.home() / '.local/share/herdr-app/herdr-app')
    core = str(Path.home() / '.local/bin/hc')
    profile.apply_profile(profile.export_profile(ROOT / 'profile'), root / 'app', root / 'sync')
    fixture = PortdFixture()
    # Only the disposable copy talks to this fixture. Never toggle real tunnels.
    model = root / 'app/mods/odysseas-ports/model.js'
    model.write_text(model.read_text().replace('const API_PORT = 43117;', f'const API_PORT = {fixture.port};'))
    profile.atomic_write(root / 'app/shared.json', json.dumps({'layout':layout, 'frame.welcomed':'finished', 'workspace.panels':['files','changes']}).encode())
    log = (root / 'app.log').open('w')
    display_log = (root / 'display.log').open('w')
    xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=display_log, text=True)
    process = None
    try:
        number = xvfb.stdout.readline().strip()
        if not number:
            raise RuntimeError('Xvfb did not start')
        env['DISPLAY'] = ':' + number
        process = subprocess.Popen([app], env=env, stdout=log, stderr=log)
        def call(*args):
            return subprocess.check_output([app, *args], env=env, text=True, stderr=subprocess.STDOUT)
        def inspect():
            return json.loads(call('ls'))
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError('App exited: ' + (root / 'app.log').read_text()[-6000:])
            try:
                status = json.loads(call('status'))
                data = inspect()
                break
            except (subprocess.CalledProcessError, json.JSONDecodeError):
                pass
            time.sleep(.15)
        else:
            raise RuntimeError('App startup timed out')
        call('do', 'overlay.close')
        call('do', 'space.new', json.dumps({'name':'Profile test', 'folder':str(root)}))
        time.sleep(.3)
        data = inspect()
        (root / 'initial-ls.json').write_text(json.dumps(data, indent=2))
        # The custom mod must load and render, not merely leave a last-good screen.
        checks = []
        for mod in sorted((root / 'app/mods').glob('odysseas-*')):
            check = subprocess.run([app, 'check', str(mod)], env=env, text=True, capture_output=True)
            if check.returncode:
                raise RuntimeError('Mod check failed: ' + check.stdout + check.stderr)
            checks.append(check.stdout)
        if layout == 'odysseas-t3':
            call('do', 'odysseas-t3-chrome.sidebar')
            time.sleep(.3)
            call('shot', str(root / 't3-focus.png'))
            assert not json.loads(call('status'))['errors'], call('status')
            call('do', 'odysseas-t3-chrome.sidebar')
            call('do', 'mod.open', json.dumps({'name':'odysseas-t3-new-menu'}))
            time.sleep(.3)
            assert not json.loads(call('status'))['errors'], call('status')
            call('do', 'overlay.close')
        windows = subprocess.check_output(['xdotool', 'search', '--name', 'Herdr'], env=env, text=True).splitlines()
        wid = windows[-1]
        subprocess.run(['xdotool', 'windowfocus', '--sync', wid], env=env, check=True)
        def key(sequence):
            subprocess.run(['xdotool', 'key', '--clearmodifiers', '--delay', '60', *sequence], env=env, check=True)
            time.sleep(.35)
        def shape():
            d = inspect()
            tabs = [t for s in d['spaces'] for t in s.get('tabs', [])]
            return len(tabs), sum(len(t.get('terminals', [])) for t in tabs)
        initial = shape()
        # Native development ports: actual keyboard/input widgets, in-memory API.
        key(['ctrl+space', 'o'])
        for _ in range(60):
            if fixture.history: break
            time.sleep(.1)
        time.sleep(.4)
        assert fixture.history, 'ports dialog never requested fixture status'
        assert shape() == initial, 'ports dialog opened a terminal/tab'
        assert not json.loads(call('status'))['errors'], call('status')
        call('shot', str(root / 'ports-forward.png'))
        key(['Return'])
        fixture.wait_post('/api/tunnels/3000/toggle')
        key(['2', 'Return'])
        fixture.wait_post('/api/reverse/5037/5039/toggle')
        call('shot', str(root / 'ports-reverse.png'))
        key(['1', 'l'])
        key(['ctrl+a'])
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '12', 'Native label'], env=env, check=True)
        key(['Return'])
        fixture.wait_post('/api/tunnels/3000/label', {'label': 'Native label'})
        key(['g', 'ctrl+a'])
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '12', 'Native work'], env=env, check=True)
        key(['Return'])
        fixture.wait_post('/api/tunnels/3000/group', {'group': 'Native work'})
        key(['bracketright'])
        fixture.wait_post('/api/tunnels/3000/move', {'scope': 'port', 'direction': 1})
        key(['m'])
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '12', '4500'], env=env, check=True)
        key(['Return'])
        fixture.wait_post('/api/tunnels/4500/toggle')
        fixture.fail = True
        key(['r'])
        count = len(fixture.posts())
        key(['Return'])
        assert len(fixture.posts()) == count, 'stale ports remained actionable'
        call('shot', str(root / 'ports-offline.png'))
        fixture.fail = False
        key(['r'])
        key(['slash'])
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '12', 'Native label'], env=env, check=True)
        call('shot', str(root / 'ports-filter.png'))
        key(['Return', 'Escape'])
        assert shape() == initial, 'closing ports changed tabs or terminals'
        assert not json.loads(call('status'))['errors'], call('status')
        (root / 'ports-requests.json').write_text(json.dumps(fixture.history, indent=2))
        if layout == 'odysseas-t3':
            def stack_is(stack, expected):
                state_path = root / 'app/layouts/.state/odysseas-t3.json'
                for _ in range(60):
                    saved = json.loads(state_path.read_text()) if state_path.exists() else {}
                    default = 'lists' if stack == 'sidebar-lists' else 'main'
                    if saved.get('nodes', {}).get(stack, {}).get('active', default) == expected:
                        return
                    time.sleep(.05)
                raise AssertionError((stack, expected, saved))
            for stroke, stack, selected, restored in [
                ('a', 'sidebar-lists', 'focus', 'lists'),
                ('shift+a', 'view', 'agent', 'main'),
            ]:
                key(['ctrl+space', stroke])
                stack_is(stack, selected)
                key(['ctrl+space', stroke])
                stack_is(stack, restored)
            assert shape() == initial, 'T3 view toggles changed terminals or tabs'
        key(['ctrl+space'])
        call('shot', str(root / 'prefix-active.png'))
        (root / 'prefix-status.json').write_text(call('status'))
        key(['c'])
        assert shape()[0] == initial[0] + 1, ('prefix c did not create a tab', inspect())
        key(['ctrl+space','v'])
        assert shape()[1] == initial[1] + 2, ('prefix v did not split', inspect())
        right = json.loads(call('status'))['focused_pane']
        key(['ctrl+space','h'])
        assert json.loads(call('status'))['focused_pane'] != right, 'prefix h did not move left'
        key(['ctrl+space','BackSpace'])
        assert json.loads(call('status'))['focused_pane'] == right, 'last pane did not restore focus'
        # Prefix is a sequence, not a simultaneous Ctrl+Space+C chord.
        before = shape()[0]
        key(['ctrl+space'])
        time.sleep(1.3)
        key(['c'])
        assert shape()[0] == before + 1, 'prefix expired before its action'
        key(['ctrl+space','ctrl+f'])
        key(['ctrl+space','question'])
        call('shot', str(root / 'prefix-help.png'))
        call('do','overlay.close')
        call('shot', str(root / 'layout.png'))
        # Record raw terminal bytes to prove prefix strokes never leak into the
        # program, and that even no-op/sidebar actions restore keyboard focus.
        capture = root / 'keys.bin'
        ready = root / 'recorder-ready'
        recorder = ('import os,sys,tty\nfrom pathlib import Path\n'
                    'tty.setraw(sys.stdin.fileno())\n'
                    f'out=Path({str(capture)!r})\nout.write_bytes(b"")\n'
                    f'Path({str(ready)!r}).touch()\n'
                    'while True:\n with out.open("ab") as f: f.write(os.read(0, 1))\n')
        call('do', 'tab.new', json.dumps({'name':'Raw key test', 'argv':['python3','-u','-c',recorder]}))
        for _ in range(60):
            if ready.exists(): break
            time.sleep(.1)
        assert ready.exists(), 'raw key recorder did not start'
        raw_focus = json.loads(call('status'))
        def recorded(expected):
            for _ in range(40):
                if capture.read_bytes() == expected: return
                time.sleep(.05)
            raise AssertionError(('wrong terminal bytes', capture.read_bytes(), expected))
        key(['ctrl+space','Escape','a'])
        recorded(b'a')
        key(['ctrl+space','Return','b'])  # An unbound second stroke cancels; no replay.
        recorded(b'ab')
        key(['ctrl+space','ctrl+space','c'])
        recorded(b'ab\x00c')
        key(['ctrl+space','z','d'])  # Zoom with one pane is a no-op.
        recorded(b'ab\x00cd')
        key(['ctrl+space','ctrl+f','e'])
        recorded(b'ab\x00cde')
        key(['ctrl+space'])
        subprocess.run(['xdotool','mousemove','--window',wid,'350','180','click','1'],env=env,check=True)
        time.sleep(.2)
        key(['f'])
        recorded(b'ab\x00cdef')
        key(['ctrl+space','percent'])
        key(['ctrl+space','BackSpace','g'])
        assert json.loads(call('status'))['focused_pane'] == raw_focus['focused_pane']
        recorded(b'ab\x00cdefg')
        # A scoped prefix Alt+2 must not accidentally select space 2.
        call('do','space.new',json.dumps({'name':'Other space','folder':str(root)}))
        call('do','pane.focus',json.dumps({'pane':raw_focus['focused_pane']}))
        key(['ctrl+space','alt+2','h'])
        assert json.loads(call('status'))['space'] == raw_focus['space']
        recorded(b'ab\x00cdefgh')
        # Tight strokes must work without waiting for a badge redraw.
        subprocess.run(['xdotool','key','--clearmodifiers','--delay','0','ctrl+space','z','i'],env=env,check=True)
        time.sleep(.4)
        recorded(b'ab\x00cdefghi')
        key(['ctrl+space','ctrl+shift+z','j'])
        recorded(b'ab\x00cdefghij')
        before = shape()[0]
        key(['ctrl+space','ctrl+shift+t'])
        assert shape()[0] == before + 1, 'direct shortcut stopped working in prefix mode'
        assert json.loads(call('status'))['focused_pane'] != raw_focus['focused_pane'], 'prefix stole focus back after a direct shortcut'
        call('do','pane.focus',json.dumps({'pane':raw_focus['focused_pane']}))
        key(['ctrl+space'])
        call('do','pane.focus',json.dumps({'pane':raw_focus['focused_pane']}))
        time.sleep(.2)
        key(['k'])
        recorded(b'ab\x00cdefghijk')
        call('shot', str(root / 'prefix-inactive.png'))
        # The built-in layouts retain native sequences as a fallback.
        call('do','layout.switch',json.dumps({'name':'main'}))
        before = shape()[0]
        key(['ctrl+space','c'])
        assert shape()[0] == before + 1, 'native prefix fallback failed outside odysseas'
        call('do','layout.switch',json.dumps({'name':layout}))
        final = json.loads(call('status'))
        assert not final['errors'], final['errors']
        (root / 'status.json').write_text(json.dumps(final, indent=2))
        (root / 'final-ls.json').write_text(call('ls'))
        print(json.dumps({'result':'PASS','artifacts':str(root),'initial_shape':initial,'final_shape':shape(),'status':final,'mod_check':''.join(checks)}, indent=2))
    finally:
        if process is not None and process.poll() is None:
            subprocess.run([app,'shot',str(root / 'last-frame.png')],env=env,capture_output=True,timeout=10)
            (root / 'last-status.json').write_text(subprocess.check_output([app,'status'],env=env,text=True))
            subprocess.run([app,'do','window.close'],env=env,capture_output=True,timeout=10)
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=8)
        fixture.close()
        # Only this test's private session and holders, never the user's core.
        subprocess.run([core,'server','stop'],env=env,capture_output=True,timeout=10)
        xvfb.terminate(); xvfb.wait(timeout=8)
        log.close(); display_log.close()
        print('Private UI test artifacts:', root)


if __name__ == '__main__':
    main()
