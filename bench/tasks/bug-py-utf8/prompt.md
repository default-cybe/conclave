Some clients fail on GET /tasks/<id> with "Unterminated string". I think json.dumps in api.py writes bad JSON for some titles.

It happens for tasks with titles like "Café crème". Tasks with plain English titles work. Please find the cause and fix it.
