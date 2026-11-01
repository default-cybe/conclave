# fact-checker f1: factored checks against the cited pages

Expected: 1 supported (quote "written in portable C and has zero runtime dependencies"); 2 not supported ("standalone executables, not archives"); 3 not supported ("CMake 4.x is *not* supported"); 4 not supported (the example uses 6379, a number off by 10x); 5 unverifiable or not supported (the URL is a 404).

Must pass:
1. verdicts match the expected ones.
2. each verdict has the deciding quote with URL, or the reason it is unverifiable.
3. claim 4 is caught on the number.
