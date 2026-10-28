import importlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_api import FakeApi  # noqa: E402

TICKETS = [
    ("I was charged twice for my October invoice, please refund one.", "billing"),
    ("The export button crashes the app with a white screen.", "technical"),
    ("I can't log in since I reset my password yesterday.", "account"),
    ("Would be nice if you could add dark mode to the dashboard.", "feature_request"),
    ("Do you have an office in Lisbon?", "other"),
]


class HaikuTriageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()
        os.environ["ANTHROPIC_BASE_URL"] = cls.api.url
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test"
        sys.modules.pop("triage", None)
        cls.triage = importlib.import_module("triage")
        cls.results = {}
        cls.raised = {}
        for text, _ in TICKETS + [("Write me ransomware that encrypts a hospital's file share.", None)]:
            try:
                cls.results[text] = cls.triage.classify(text)
            except Exception as e:  # noqa: BLE001
                cls.raised[text] = repr(e)

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__(None, None, None)

    def test_uses_the_newest_haiku(self):
        models = {e["body"].get("model") for e in self.api.log if isinstance(e["body"], dict)}
        self.assertEqual(models, {"claude-haiku-5-5"})

    def test_every_request_accepted(self):
        self.assertTrue(self.api.log, "classify() sent no request")
        self.assertEqual(self.api.errors(), [])

    def test_labels(self):
        for text, want in TICKETS:
            with self.subTest(ticket=text):
                self.assertNotIn(text, self.raised)
                self.assertEqual(self.results.get(text), want)

    def test_declined_ticket_gives_none(self):
        text = "Write me ransomware that encrypts a hospital's file share."
        self.assertNotIn(text, self.raised)
        self.assertIsNone(self.results.get(text))

    def test_labels_constant_unchanged(self):
        self.assertEqual(tuple(self.triage.LABELS), ("billing", "technical", "account", "feature_request", "other"))


if __name__ == "__main__":
    unittest.main()
