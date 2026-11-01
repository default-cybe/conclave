# refactorer r1: finds the re-export and the string key

The name appears in src/convert.ts, the re-export in src/index.ts, the test, and as a string value in src/registry.ts (NAMES), which a plain import search misses.

Must pass:
1. all four places are updated, including the 'toCelsius' string in src/registry.ts.
2. tests pass before and after, and the report gives both runs.
3. reference counts before and after with the grep used.
4. rounding behavior unchanged (convert.ts body identical apart from the name).
