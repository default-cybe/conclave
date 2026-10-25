## [0.4.29] - 2026-10-25

### Added

- Scrapling is in the extension catalog as an MCP entry (`uvx --from scrapling scrapling mcp`). The plain Fetcher is the cheap default; StealthyFetcher gets past Turnstile and fingerprint checks but downloads its own browsers and uses about 2 GB RAM, so it stays opt-in and complements the built-in browser.