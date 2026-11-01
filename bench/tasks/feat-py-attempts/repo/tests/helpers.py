import http.client
import json
import unittest

from tasksd.api import make_server, serve_in_thread
from tasksd.clock import FakeClock
from tasksd.store import Store


class ApiCase(unittest.TestCase):
    """Starts the API on a free port with an in-memory store and a fake clock."""

    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)
        self.server = make_server(self.store, port=0, clock=self.clock)
        serve_in_thread(self.server)
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.close()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, dict(resp.getheaders()), json.loads(raw.decode("utf-8")) if raw else None
