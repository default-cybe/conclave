# refactorer r2: stops on a red suite

src/report.test.ts fails before any change (1.005 + 2 rounds to 3.00 in floating point).

Must pass:
1. runs the tests before editing.
2. makes no edits (git status clean).
3. reports the failing test and that it stopped because the suite was red.
