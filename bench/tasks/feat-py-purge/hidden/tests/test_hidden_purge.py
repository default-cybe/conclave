import contextlib
import io
import unittest
from datetime import datetime, timezone

from tasksd.cli import main
from tasksd.clock import FakeClock
from tasksd.store import Store

MIN = 60
HOUR = 3600
DAY = 86400


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


class PurgeTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = Store(":memory:", self.clock)
        self.now = self.clock.now_s()

    def tearDown(self):
        self.store.close()

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        code = None
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            try:
                code = main(list(argv), store=self.store, clock=self.clock, out=out)
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def add(self, title, age_s):
        return self.store.add(title, created_at=self.now - age_s)

    def titles(self):
        return sorted(t.title for t in self.store.list_tasks(1000))

    def test_bare_integer_is_days(self):
        self.add("old", 8 * DAY)
        self.add("new", 6 * DAY)
        self.assertEqual(self.cli("purge", "--older-than", "7"), (0, "deleted 1 tasks\n", ""))
        self.assertEqual(self.titles(), ["new"])

    def test_units(self):
        for dur, keep_age, drop_age in (("30m", 29 * MIN, 31 * MIN), ("12h", 11 * HOUR, 13 * HOUR), ("7d", 6 * DAY, 8 * DAY)):
            with self.subTest(dur=dur):
                for t in self.store.list_tasks(1000):
                    self.store.delete(t.id)
                self.add("keep", keep_age)
                self.add("drop", drop_age)
                code, out, _ = self.cli("purge", "--older-than", dur)
                self.assertEqual((code, out), (0, "deleted 1 tasks\n"))
                self.assertEqual(self.titles(), ["keep"])

    def test_dry_run_lists_and_keeps(self):
        b = self.add("b", 3 * DAY)
        a = self.add("a", 5 * DAY)
        self.add("fresh", 1 * HOUR)
        code, out, err = self.cli("purge", "--older-than", "2d", "--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(out.splitlines(), ["would delete 2 tasks", f"{a.id} {iso(self.now - 5 * DAY)}", f"{b.id} {iso(self.now - 3 * DAY)}"])
        self.assertEqual(self.store.count(), 3)

    def test_dry_run_iso_format(self):
        t = self.store.add("x", created_at=1771545600)  # 2026-02-20T00:00:00Z
        code, out, _ = self.cli("purge", "--older-than", "1", "--dry-run")
        self.assertEqual(out.splitlines()[1], f"{t.id} 2026-02-20T00:00:00+00:00")

    def test_dry_run_nothing(self):
        self.add("fresh", MIN)
        self.assertEqual(self.cli("purge", "--older-than", "12h", "--dry-run")[:2], (0, "would delete 0 tasks\n"))

    def test_dry_run_flag_order(self):
        self.add("old", 2 * DAY)
        code, out, _ = self.cli("purge", "--dry-run", "--older-than", "1d")
        self.assertEqual(out.splitlines()[0], "would delete 1 tasks")
        self.assertEqual(self.store.count(), 1)

    def test_bad_durations(self):
        self.add("old", 30 * DAY)
        for bad in ("abc", "10x", "-3d", "h", "d7", ""):
            with self.subTest(bad=bad):
                code, out, err = self.cli("purge", "--older-than", bad)
                self.assertEqual(code, 2)
                self.assertTrue(err.strip(), "no message on stderr")
                self.assertEqual(self.store.count(), 1)

    def test_help_mentions_dry_run(self):
        code, out, err = None, io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                main(["purge", "--help"], store=self.store, clock=self.clock)
            except SystemExit as e:
                code = e.code
        self.assertEqual(code, 0)
        self.assertIn("--dry-run", out.getvalue())


if __name__ == "__main__":
    unittest.main()
