import unittest

from triage import LABELS, normalize_label


class NormalizeLabelTest(unittest.TestCase):
    def test_known_labels(self):
        for label in LABELS:
            self.assertEqual(normalize_label(label), label)

    def test_loose_spelling(self):
        self.assertEqual(normalize_label(" Feature Request "), "feature_request")
        self.assertEqual(normalize_label('"Billing"'), "billing")
        self.assertEqual(normalize_label("feature-request"), "feature_request")

    def test_unknown(self):
        self.assertIsNone(normalize_label("spam"))
        self.assertIsNone(normalize_label(None))
        self.assertIsNone(normalize_label(""))


if __name__ == "__main__":
    unittest.main()
