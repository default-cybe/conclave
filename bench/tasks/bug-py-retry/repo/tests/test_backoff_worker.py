import unittest

from tasksd import backoff
from tasksd.clock import FakeClock
from tasksd.store import Store
from tasksd.worker import Worker


class BackoffTest(unittest.TestCase):
    def test_grows_and_caps(self):
        self.assertEqual([backoff.delay(n) for n in (1, 2, 3)], [2.0, 4.0, 8.0])
        self.assertEqual(backoff.delay(30), backoff.CAP_S)
        with self.assertRaises(ValueError):
            backoff.delay(0)


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)

    def tearDown(self):
        self.store.close()

    def test_success(self):
        seen = []
        t = self.store.add("hello")
        w = Worker(self.store, {"default": lambda task: seen.append(task.id)})
        self.assertEqual(w.run_once(), 1)
        self.assertEqual(seen, [t.id])
        done = self.store.get(t.id)
        self.assertEqual((done.status, done.attempts), ("done", 1))

    def test_unknown_kind_fails(self):
        t = self.store.add("x", {"kind": "nope"}, max_attempts=1)
        Worker(self.store, {}).run_once()
        failed = self.store.get(t.id)
        self.assertEqual(failed.status, "failed")
        self.assertIn("no handler", failed.last_error)

    def test_gives_up_after_max_attempts(self):
        def boom(task):
            raise RuntimeError("down")

        t = self.store.add("flaky", max_attempts=3)
        w = Worker(self.store, {"default": boom})
        for _ in range(3):
            self.assertEqual(w.run_once(), 1)
            self.clock.advance(600_000)
        self.assertEqual(w.run_once(), 0)
        final = self.store.get(t.id)
        self.assertEqual((final.status, final.attempts), ("failed", 3))
        self.assertEqual(final.last_error, "RuntimeError: down")


if __name__ == "__main__":
    unittest.main()
