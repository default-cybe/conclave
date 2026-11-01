import io
import unittest

from tasksd.cli import main
from tasksd.clock import FakeClock
from tasksd.store import Store


class PurgeTest(unittest.TestCase):
    def test_dry_run_hours(self):
        clock = FakeClock()
        store = Store(":memory:", clock)
        now = clock.now_s()
        old = store.add("old", created_at=now - 13 * 3600)
        store.add("new", created_at=now - 3600)
        out = io.StringIO()
        self.assertEqual(main(["purge", "--older-than", "12h", "--dry-run"], store=store, clock=clock, out=out), 0)
        self.assertEqual(out.getvalue().splitlines()[0], "would delete 1 tasks")
        self.assertTrue(out.getvalue().splitlines()[1].startswith(f"{old.id} "))
        self.assertEqual(store.count(), 2)


if __name__ == "__main__":
    unittest.main()
