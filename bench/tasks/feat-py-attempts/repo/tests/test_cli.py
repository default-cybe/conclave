import io
import unittest

from tasksd.cli import DAY_S, main
from tasksd.clock import FakeClock
from tasksd.cursor import decode_cursor, encode_cursor
from tasksd.store import Store


class CliTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)
        self.out = io.StringIO()

    def run_cli(self, *argv):
        return main(list(argv), store=self.store, clock=self.clock, out=self.out)

    def test_add_and_list(self):
        self.assertEqual(self.run_cli("add", "water plants"), 0)
        self.assertEqual(self.run_cli("list"), 0)
        self.assertIn("queued\t0/3\twater plants", self.out.getvalue())

    def test_purge_days(self):
        now = self.clock.now_s()
        self.store.add("ancient", created_at=now - 10 * DAY_S)
        self.store.add("fresh", created_at=now - 60)
        self.assertEqual(self.run_cli("purge", "--older-than", "7"), 0)
        self.assertEqual(self.out.getvalue(), "deleted 1 tasks\n")
        self.assertEqual([t.title for t in self.store.list_tasks(10)], ["fresh"])

    def test_work_once(self):
        self.store.add("hello")
        self.assertEqual(self.run_cli("work", "--once"), 0)
        self.assertIn("ran 1 hello", self.out.getvalue())


class CursorTest(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(decode_cursor(encode_cursor(1700000000, 42)), (1700000000, 42))

    def test_rejects_junk(self):
        for junk in ("", "@@", "bm90IGpzb24", encode_cursor(1, 2) + "x"):
            with self.subTest(junk=junk), self.assertRaises(ValueError):
                decode_cursor(junk)


if __name__ == "__main__":
    unittest.main()
