"""Private in-memory portd API for native UI tests; never touches real tunnels."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time


class PortdFixture:
    def __init__(self):
        self.lock = threading.Lock()
        self.history = []
        self.fail = False
        self.status = {
            'host': 'debina-test', 'connected': True, 'last_error': None, 'last_scan_ms': 1,
            'tunnels': [
                {'remote_port': 3000, 'local_port': 3001, 'label': 'Web frontend', 'group': 'Luca', 'process': 'vite', 'state': 'active'},
                {'remote_port': 8000, 'local_port': 8000, 'label': 'Backend API', 'group': 'Luca', 'process': 'php', 'state': 'active'},
                {'remote_port': 8080, 'local_port': None, 'label': '', 'group': '', 'process': 'node', 'state': 'disabled'},
            ],
            'reverse_tunnels': [
                {'remote_port': 5037, 'local_port': 5039, 'process': 'adb', 'state': 'active'},
                {'remote_port': 9000, 'local_port': 9000, 'process': 'preview', 'state': 'available'},
            ],
        }
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, code, body=None):
                data = json.dumps(body).encode() if body is not None else b''
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                with fixture.lock:
                    fixture.history.append(('GET', self.path, None))
                    if fixture.fail:
                        self.reply(503, {'error': 'Fixture offline'})
                    elif self.path == '/api/status':
                        self.reply(200, fixture.status)
                    else:
                        self.reply(404)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                body = json.loads(body) if body else None
                with fixture.lock:
                    fixture.history.append(('POST', self.path, body))
                    if fixture.fail:
                        self.reply(503, {'error': 'Fixture offline'})
                        return
                    forward = re.fullmatch(r'/api/tunnels/(\d+)/(toggle|label|group|move|open)', self.path)
                    reverse = re.fullmatch(r'/api/reverse/(\d+)/(\d+)/toggle', self.path)
                    if forward:
                        port, action = int(forward[1]), forward[2]
                        row = next((r for r in fixture.status['tunnels'] if r['remote_port'] == port), None)
                        if row is None:
                            row = {'remote_port': port, 'local_port': None, 'label': '', 'group': '', 'process': 'manual', 'state': 'available'}
                            fixture.status['tunnels'].append(row)
                        if action == 'toggle':
                            row['local_port'] = None if row['local_port'] else port
                            row['state'] = 'active' if row['local_port'] else 'disabled'
                        elif action in ('label', 'group'):
                            row[action] = body[action]
                    elif reverse:
                        remote, local = int(reverse[1]), int(reverse[2])
                        row = next((r for r in fixture.status['reverse_tunnels'] if r['remote_port'] == remote), None)
                        if row and row['state'] != 'available':
                            row['state'] = 'available'
                        elif row:
                            row.update(local_port=local, state='active')
                        else:
                            fixture.status['reverse_tunnels'].append({'remote_port': remote, 'local_port': local, 'process': 'manual', 'state': 'active'})
                    elif self.path != '/api/refresh':
                        self.reply(404)
                        return
                    fixture.status['last_scan_ms'] += 1
                    self.reply(204)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def snapshot(self):
        with self.lock:
            return deepcopy(self.status)

    def posts(self):
        with self.lock:
            return [entry for entry in self.history if entry[0] == 'POST']

    def wait_post(self, path, body=None):
        for _ in range(80):
            matches = [entry for entry in self.posts() if entry[1] == path and (body is None or entry[2] == body)]
            if matches:
                time.sleep(.3)  # Let the following GET and native render finish.
                return
            time.sleep(.05)
        raise AssertionError(('missing fixture request', path, body, self.posts()))

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
