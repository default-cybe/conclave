import http.client
import json
import unittest

from tasksd.api import make_server, serve_in_thread
from tasksd.clock import FakeClock
from tasksd.store import Store
from tasksd.worker import Worker


class AttemptsApiTest(unittest.TestCase):
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

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, json.loads(raw.decode("utf-8"))

    def task_with_attempts(self, count):
        t = self.store.add("job", max_attempts=50)
        for n in range(1, count + 1):
            ok = n == count
            self.store.record_attempt(t.id, n, 1000 * n, 1000 * n + 250, ok, None if ok else f"fail {n}")
        return t

    def test_shape_and_order(self):
        t = self.task_with_attempts(3)
        status, body = self.get(f"/tasks/{t.id}/attempts")
        self.assertEqual(status, 200)
        self.assertEqual(
            body,
            {
                "task_id": t.id,
                "attempts": [
                    {"n": 3, "started_at": 3000, "finished_at": 3250, "ok": True, "error": None},
                    {"n": 2, "started_at": 2000, "finished_at": 2250, "ok": False, "error": "fail 2"},
                    {"n": 1, "started_at": 1000, "finished_at": 1250, "ok": False, "error": "fail 1"},
                ],
            },
        )

    def test_ok_is_a_boolean(self):
        t = self.task_with_attempts(2)
        _, body = self.get(f"/tasks/{t.id}/attempts")
        self.assertIs(body["attempts"][0]["ok"], True)
        self.assertIs(body["attempts"][1]["ok"], False)

    def test_no_attempts_yet(self):
        t = self.store.add("new")
        self.assertEqual(self.get(f"/tasks/{t.id}/attempts"), (200, {"task_id": t.id, "attempts": []}))

    def test_default_limit_is_20(self):
        t = self.task_with_attempts(30)
        _, body = self.get(f"/tasks/{t.id}/attempts")
        self.assertEqual([a["n"] for a in body["attempts"]], list(range(30, 10, -1)))

    def test_limit(self):
        t = self.task_with_attempts(30)
        _, body = self.get(f"/tasks/{t.id}/attempts?limit=5")
        self.assertEqual([a["n"] for a in body["attempts"]], [30, 29, 28, 27, 26])
        _, body = self.get(f"/tasks/{t.id}/attempts?limit=100")
        self.assertEqual(len(body["attempts"]), 30)

    def test_bad_limits(self):
        t = self.task_with_attempts(2)
        for bad in ("0", "101", "-1", "abc", "2.5", ""):
            with self.subTest(limit=bad):
                status, body = self.get(f"/tasks/{t.id}/attempts?limit={bad}")
                if bad == "":
                    self.assertIn(status, (200, 400))
                    continue
                self.assertEqual(status, 400)
                self.assertIsInstance(body.get("error"), str)

    def test_unknown_task(self):
        self.assertEqual(self.get("/tasks/12345/attempts"), (404, {"error": "not found"}))

    def test_only_that_task(self):
        a = self.task_with_attempts(2)
        b = self.task_with_attempts(4)
        _, body = self.get(f"/tasks/{a.id}/attempts")
        self.assertEqual(body["task_id"], a.id)
        self.assertEqual([x["n"] for x in body["attempts"]], [2, 1])
        _, body = self.get(f"/tasks/{b.id}/attempts?limit=1")
        self.assertEqual([x["n"] for x in body["attempts"]], [4])

    def test_worker_attempts_show_up(self):
        def boom(task):
            raise RuntimeError("nope")

        t = self.store.add("flaky", max_attempts=3)
        w = Worker(self.store, {"default": boom}, self.clock)
        w.run_once()
        self.clock.advance(5000)
        w.run_once()
        _, body = self.get(f"/tasks/{t.id}/attempts")
        self.assertEqual([x["n"] for x in body["attempts"]], [2, 1])
        self.assertEqual(body["attempts"][0]["error"], "RuntimeError: nope")
        self.assertEqual(body["attempts"][0]["started_at"], self.clock.now_ms())

    def test_other_routes_unchanged(self):
        t = self.store.add("x")
        self.assertEqual(self.get(f"/tasks/{t.id}")[1]["title"], "x")
        self.assertEqual(self.get("/tasks/abc/attempts")[0], 404)


if __name__ == "__main__":
    unittest.main()
