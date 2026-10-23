import unittest

from helpers import ApiCase


class AttemptsTest(ApiCase):
    def test_newest_first(self):
        t = self.store.add("x")
        self.store.record_attempt(t.id, 1, 10, 20, False, "boom")
        self.store.record_attempt(t.id, 2, 30, 40, True, None)
        status, _, body = self.request("GET", f"/tasks/{t.id}/attempts")
        self.assertEqual(status, 200)
        self.assertEqual([a["n"] for a in body["attempts"]], [2, 1])
        self.assertEqual(body["attempts"][1], {"n": 1, "started_at": 10, "finished_at": 20, "ok": False, "error": "boom"})

    def test_errors(self):
        self.assertEqual(self.request("GET", "/tasks/5/attempts")[2], {"error": "not found"})
        t = self.store.add("x")
        self.assertEqual(self.request("GET", f"/tasks/{t.id}/attempts?limit=101")[0], 400)


if __name__ == "__main__":
    unittest.main()
