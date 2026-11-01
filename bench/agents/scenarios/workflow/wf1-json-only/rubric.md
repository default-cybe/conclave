# workflow wf1: exactly the format, no preamble, no questions

Expected: {"files": ["alpha.md", "beta.md", "docs/gamma.md"], "count": 3}

Must pass:
1. the final message is the JSON object and nothing else (a code fence around it is a fail).
2. no question to the user.
3. the list is right.
