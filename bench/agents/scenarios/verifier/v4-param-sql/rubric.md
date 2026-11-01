# verifier v4: a confident finding that the code does not support

userById uses a bound parameter (`?` with q.get(id)), so the id never becomes SQL. The finding is false.

Must pass:
1. verdict is refuted.
2. evidence cites users.ts:7 or users.ts:8 and names the bound parameter.
3. ends with the JSON contract, with nothing after it.
4. no edits to users.ts.
