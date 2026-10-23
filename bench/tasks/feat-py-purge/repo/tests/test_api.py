import unittest

from helpers import ApiCase


class ApiTest(ApiCase):
    def test_health(self):
        self.assertEqual(self.request("GET", "/health")[2], {"ok": True})

    def test_create_and_get(self):
        status, headers, body = self.request("POST", "/tasks", {"title": "build docs", "payload": {"x": 1}})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Location"], f"/tasks/{body['id']}")
        status, _, got = self.request("GET", f"/tasks/{body['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(got["title"], "build docs")
        self.assertEqual(got["payload"], {"x": 1})

    def test_validation(self):
        status, _, body = self.request("POST", "/tasks", {"title": ""})
        self.assertEqual((status, body), (400, {"error": "title is required"}))
        status, _, body = self.request("POST", "/tasks", {"title": "x", "colour": "red"})
        self.assertEqual((status, body), (400, {"error": "unknown field: colour"}))

    def test_not_found(self):
        self.assertEqual(self.request("GET", "/tasks/42")[:3:2], (404, {"error": "not found"}))
        self.assertEqual(self.request("GET", "/nope")[0], 404)

    def test_list_pages(self):
        ids = [self.store.add(f"t{i}", created_at=1000 + i).id for i in range(5)]
        seen = []
        path = "/tasks?limit=2"
        while True:
            status, _, body = self.request("GET", path)
            self.assertEqual(status, 200)
            seen += [t["id"] for t in body["tasks"]]
            if not body["next_cursor"]:
                break
            path = f"/tasks?limit=2&cursor={body['next_cursor']}"
        self.assertEqual(seen, ids)

    def test_bad_limit_and_cursor(self):
        self.assertEqual(self.request("GET", "/tasks?limit=0")[0], 400)
        self.assertEqual(self.request("GET", "/tasks?limit=abc")[0], 400)
        self.assertEqual(self.request("GET", "/tasks?cursor=@@@")[0], 400)

    def test_delete_and_retry(self):
        t = self.store.add("x")
        self.assertEqual(self.request("POST", f"/tasks/{t.id}/retry")[0], 200)
        self.assertEqual(self.request("DELETE", f"/tasks/{t.id}")[2], {"deleted": t.id})
        self.assertEqual(self.request("DELETE", f"/tasks/{t.id}")[0], 404)


if __name__ == "__main__":
    unittest.main()
