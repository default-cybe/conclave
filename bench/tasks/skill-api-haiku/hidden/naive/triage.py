"""Label support tickets with Claude.

classify(ticket_text) returns one of LABELS, or None when the model gives no
usable label. Run `python3 triage.py tickets.jsonl` to label a file of tickets
(one JSON object with a "text" field per line) and print the counts.

Reads ANTHROPIC_API_KEY, and ANTHROPIC_BASE_URL when set (as the SDKs do).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter

LABELS = ("billing", "technical", "account", "feature_request", "other")

MODEL = "claude-haiku-5-5"

SYSTEM = (
    "You label customer support tickets for a small SaaS company. "
    "Pick exactly one label from: billing, technical, account, feature_request, other. "
    'Answer with JSON of the form {"label": "<label>"} and nothing else.'
)

PREFIX = '{"label": "'


def _url():
    base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    return base + "/v1/messages"


def _post(body):
    req = urllib.request.Request(
        _url(),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": os.environ.get("ANTHROPIC_API_KEY", ""),
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Claude API error {e.code}: {e.read().decode('utf-8', 'replace')}") from None


def normalize_label(raw):
    """Map what the model wrote to one of LABELS, or None."""
    if raw is None:
        return None
    s = str(raw).strip().strip('"').strip().lower().replace("-", "_").replace(" ", "_")
    return s if s in LABELS else None


def classify(ticket_text):
    body = {
        "model": MODEL,
        "max_tokens": 20,
        "system": SYSTEM,
        "messages": [
            {"role": "user", "content": ticket_text},
            {"role": "assistant", "content": PREFIX},
        ],
    }
    data = _post(body)
    text = PREFIX + data["content"][0]["text"]
    try:
        return normalize_label(json.loads(text).get("label"))
    except ValueError:
        return normalize_label(text[len(PREFIX):].split('"')[0])


def main(path):
    counts = Counter()
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                counts[classify(json.loads(line)["text"]) or "unlabeled"] += 1
    for label, n in counts.most_common():
        print(f"{label}\t{n}")


if __name__ == "__main__":
    main(sys.argv[1])
