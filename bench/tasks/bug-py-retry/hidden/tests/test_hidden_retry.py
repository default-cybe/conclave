import http.client
import unittest

from tasksd import backoff
from tasksd.api import make_server, serve_in_thread
from tasksd.clock import FakeClock
from tasksd.store import Store
from tasksd.worker import Worker


def boom(task):
    raise RuntimeError("upstream down")


class RetryTimingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)
        self.worker = Worker(self.store, {"default": boom}, self.clock)

    def tearDown(self):
        self.store.close()

    def test_backoff_is_in_seconds(self):
        self.assertEqual(backoff.delay(1), 2)
        self.assertEqual(backoff.delay(2), 4)
        self.assertEqual(backoff.delay(3), 8)
        self.assertEqual(backoff.delay(20), 300)

    def test_first_retry_waits_two_seconds(self):
        t = self.store.add("flaky", max_attempts=5)
        start = self.clock.now_ms()
        self.assertEqual(self.worker.run_once(), 1)
        self.assertEqual(self.store.get(t.id).next_run_at_ms, start + 2000)

    def test_no_hot_loop(self):
        t = self.store.add("flaky", max_attempts=5)
        self.worker.run_once()
        runs = 0
        for _ in range(199):  # 1990 ms in 10 ms steps
            self.clock.advance(10)
            runs += self.worker.run_once()
        self.assertEqual(runs, 0)
        self.assertEqual(self.store.get(t.id).attempts, 1)
        self.clock.advance(10)
        self.assertEqual(self.worker.run_once(), 1)
        self.assertEqual(self.store.get(t.id).attempts, 2)

    def test_delays_double(self):
        t = self.store.add("flaky", max_attempts=5)
        expected = []
        seen = []
        for n in range(1, 5):
            self.assertEqual(self.worker.run_once(), 1)
            task = self.store.get(t.id)
            gap = task.next_run_at_ms - self.clock.now_ms()
            seen.append(gap)
            expected.append(int(backoff.delay(n) * 1000))
            self.clock.set(task.next_run_at_ms)
        self.assertEqual(seen, [2000, 4000, 8000, 16000])
        self.assertEqual(seen, expected)

    def test_gives_up(self):
        t = self.store.add("flaky", max_attempts=2)
        self.worker.run_once()
        self.clock.advance(2000)
        self.worker.run_once()
        self.assertEqual(self.store.get(t.id).status, "failed")


class RetryAfterHeaderTest(unittest.TestCase):
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

    def get(self, task_id):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", f"/tasks/{task_id}")
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp

    def test_retry_after_in_seconds(self):
        t = self.store.add("flaky", max_attempts=5)
        w = Worker(self.store, {"default": boom}, self.clock)
        w.run_once()
        self.assertEqual(self.get(t.id).getheader("Retry-After"), "2")
        self.clock.advance(2000)
        w.run_once()
        self.assertEqual(self.get(t.id).getheader("Retry-After"), "4")

    def test_no_retry_after_when_due(self):
        t = self.store.add("fresh")
        self.assertIsNone(self.get(t.id).getheader("Retry-After"))


if __name__ == "__main__":
    unittest.main()
