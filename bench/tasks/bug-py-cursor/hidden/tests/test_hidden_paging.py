import http.client
import json
import unittest

from tasksd.api import make_server, serve_in_thread
from tasksd.clock import FakeClock
from tasksd.store import Store

T0 = 1_772_323_200


class PagingTest(unittest.TestCase):
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
        body = json.loads(resp.read().decode("utf-8"))
        conn.close()
        return resp.status, body

    def pages(self, limit):
        out = []
        path = f"/tasks?limit={limit}"
        for _ in range(1000):
            status, body = self.get(path)
            self.assertEqual(status, 200, body)
            out.append(body["tasks"])
            if not body["next_cursor"]:
                return out
            path = f"/tasks?limit={limit}&cursor={body['next_cursor']}"
        self.fail("paging did not end")

    def bulk_import(self, n, stamps):
        # a bulk import: many tasks share a second, and they arrive out of time order
        expected = []
        for i in range(n):
            created = stamps[i % len(stamps)]
            t = self.store.add(f"task {i}", created_at=created)
            expected.append((created, t.id))
        return [tid for _, tid in sorted(expected)]

    def test_every_task_once_in_order(self):
        expected = self.bulk_import(120, [T0 + 60, T0, T0 + 30])
        pages = self.pages(7)
        ids = [t["id"] for page in pages for t in page]
        self.assertEqual(len(ids), len(set(ids)), "a task was listed twice")
        self.assertEqual(sorted(ids), sorted(expected), "a task was skipped")
        self.assertEqual(ids, expected, "order is not created_at, then id")

    def test_pages_are_full(self):
        self.bulk_import(120, [T0 + 60, T0, T0 + 30])
        sizes = [len(p) for p in self.pages(7)]
        self.assertTrue(all(s == 7 for s in sizes[:-1]), sizes)
        self.assertEqual(sum(sizes), 120)
        self.assertEqual(sizes[-1], 120 - 7 * (len(sizes) - 1))

    def test_one_second_holds_more_than_a_page(self):
        expected = self.bulk_import(25, [T0])
        ids = [t["id"] for page in self.pages(4) for t in page]
        self.assertEqual(ids, expected)

    def test_page_size_one(self):
        expected = self.bulk_import(9, [T0, T0 + 1, T0])
        ids = [t["id"] for page in self.pages(1) for t in page]
        self.assertEqual(ids, expected)

    def test_exact_multiple_has_no_empty_last_page(self):
        self.bulk_import(14, [T0, T0 + 5])
        pages = self.pages(7)
        self.assertEqual([len(p) for p in pages], [7, 7])

    def test_distinct_seconds_still_work(self):
        expected = [self.store.add(f"t{i}", created_at=T0 + i).id for i in range(10)]
        ids = [t["id"] for page in self.pages(3) for t in page]
        self.assertEqual(ids, expected)

    def test_cursor_is_opaque_and_checked(self):
        self.bulk_import(10, [T0])
        status, body = self.get("/tasks?limit=3")
        self.assertIsInstance(body["next_cursor"], str)
        status, _ = self.get("/tasks?limit=3&cursor=not-a-cursor!")
        self.assertEqual(status, 400)

    def test_limit_bounds(self):
        self.assertEqual(self.get("/tasks?limit=201")[0], 400)
        self.assertEqual(self.get("/tasks?limit=200")[0], 200)


if __name__ == "__main__":
    unittest.main()
