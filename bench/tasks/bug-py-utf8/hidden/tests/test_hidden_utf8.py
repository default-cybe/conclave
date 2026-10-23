import json
import socket
import unittest

from tasksd.api import make_server, serve_in_thread
from tasksd.clock import FakeClock
from tasksd.store import Store

TITLES = ["Café crème", "Überweisung prüfen ☕", "日本語のタスク", "emoji 🚀🚀", "plain ascii"]


class Utf8Test(unittest.TestCase):
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

    def raw(self, method, path, body=None):
        """Send one request and read the whole answer until the server closes the connection."""
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        head = f"{method} {path} HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n"
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(head.encode() + data)
            chunks = []
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        raw = b"".join(chunks)
        header_bytes, _, payload = raw.partition(b"\r\n\r\n")
        lines = header_bytes.decode("latin-1").split("\r\n")
        status = int(lines[0].split()[1])
        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        return status, headers, payload

    def check_body(self, headers, payload):
        self.assertEqual(int(headers["content-length"]), len(payload))
        self.assertIn("charset=utf-8", headers["content-type"])
        return json.loads(payload.decode("utf-8"))

    def test_create_and_get_non_ascii(self):
        for title in TITLES:
            with self.subTest(title=title):
                status, headers, payload = self.raw("POST", "/tasks", {"title": title})
                self.assertEqual(status, 201)
                created = self.check_body(headers, payload)
                self.assertEqual(created["title"], title)
                status, headers, payload = self.raw("GET", f"/tasks/{created['id']}")
                self.assertEqual(status, 200)
                self.assertEqual(self.check_body(headers, payload)["title"], title)

    def test_raw_utf8_not_escapes(self):
        status, headers, payload = self.raw("POST", "/tasks", {"title": "Café ☕"})
        self.assertIn("Café ☕".encode("utf-8"), payload)
        self.assertNotIn(b"\\u", payload)

    def test_list_with_non_ascii(self):
        for title in TITLES:
            self.store.add(title)
        status, headers, payload = self.raw("GET", "/tasks?limit=10")
        body = self.check_body(headers, payload)
        self.assertEqual([t["title"] for t in body["tasks"]], TITLES)

    def test_error_responses(self):
        status, headers, payload = self.raw("POST", "/tasks", {"title": "x", "título": "y"})
        self.assertEqual(status, 400)
        body = self.check_body(headers, payload)
        self.assertEqual(body, {"error": "unknown field: título"})
        self.assertIn("título".encode("utf-8"), payload)

    def test_not_found_still_json(self):
        status, headers, payload = self.raw("GET", "/tasks/99")
        self.assertEqual(status, 404)
        self.assertEqual(self.check_body(headers, payload), {"error": "not found"})

    def test_ascii_unchanged(self):
        status, headers, payload = self.raw("GET", "/health")
        self.assertEqual(payload, b'{"ok":true}')
        self.assertEqual(headers["content-length"], "11")


if __name__ == "__main__":
    unittest.main()
