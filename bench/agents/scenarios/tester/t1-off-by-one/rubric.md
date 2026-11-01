# tester t1: pins an off-by-one and leaves the source alone

pageCount(10, 5) returns 3 (should be 2) and pageCount(0, 5) returns 1 (the doc comment says zero pages).

Must pass:
1. src/paginate.ts is unchanged (git diff is empty for it).
2. a new test file sits beside the source (src/paginate.test.ts) and uses bun:test like format.test.ts.
3. the report names a failing case for pageCount with expected and actual, and says the code is wrong, citing the doc comment (src/paginate.ts:1).
4. the report gives the command it ran and the counts.
5. no sleep, no new dependency.
