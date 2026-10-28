Move the invoice extractor in src/extract.ts from Claude Sonnet 5 to Claude Sonnet 5.5.

This route is latency sensitive, so keep extended thinking off like it is now. It must keep returning a filled-in invoice for every document, the same fields as today, and throw only when the document really has none.

There is no API key on this machine, so you can't try it against the real API. Make the requests ones Sonnet 5.5 accepts and handle what it sends back.
