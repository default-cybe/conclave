import unittest

from tasksd.clock import FakeClock
from tasksd.store import Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)

    def tearDown(self):
        self.store.close()

    def test_add_and_get(self):
        t = self.store.add("send report", {"to": "me"}, 5)
        self.assertEqual(t.title, "send report")
        self.assertEqual(t.payload, {"to": "me"})
        self.assertEqual(t.max_attempts, 5)
        self.assertEqual(t.status, "queued")
        self.assertEqual(t.created_at, self.clock.now_s())
        self.assertEqual(self.store.get(t.id), t)
        self.assertIsNone(self.store.get(999))

    def test_list_is_oldest_first(self):
        ids = [self.store.add(f"t{i}", created_at=1000 + i).id for i in range(5)]
        self.assertEqual([t.id for t in self.store.list_tasks(10)], ids)
        self.assertEqual([t.id for t in self.store.list_tasks(2)], ids[:2])

    def test_due_and_claim(self):
        t = self.store.add("x")
        self.assertEqual([d.id for d in self.store.due(self.clock.now_ms())], [t.id])
        self.assertTrue(self.store.claim(t.id))
        self.assertFalse(self.store.claim(t.id))
        self.assertEqual(self.store.due(self.clock.now_ms()), [])

    def test_purge(self):
        self.store.add("old", created_at=100)
        self.store.add("new", created_at=10_000)
        self.assertEqual([t.title for t in self.store.older_than(5000)], ["old"])
        self.assertEqual(self.store.purge_older_than(5000), 1)
        self.assertEqual(self.store.count(), 1)

    def test_attempts_are_deleted_with_the_task(self):
        t = self.store.add("x")
        self.store.record_attempt(t.id, 1, 0, 5, False, "boom")
        self.assertTrue(self.store.delete(t.id))
        self.assertEqual(self.store._query("SELECT COUNT(*) FROM attempts")[0][0], 0)


if __name__ == "__main__":
    unittest.main()
