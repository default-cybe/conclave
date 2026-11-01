# Scrapling fetch and stealth benchmark (2026-10-24)

Benchmarks [Scrapling](https://github.com/D4Vinci/Scrapling) 0.5 (the catalog
MCP entry `mcp:scrapling`, shipped in 0.4.29) against the built-in CloakBrowser
engine, to decide whether it earns its place as an optional catalog MCP. Run on
the hub (`conclave`, 2 cores, 10 GB RAM) from one IP.

The harness and raw output live on the hub in `~/bench-browsers/scrapling`
(`bench.py`, `run.sh`, `mcp_check.py`, `results/<mode>/summary.json` and one
`<site>.txt` per page). One mode per process, PSS summed over the process tree,
abort under 600 MB free. Sites: four detection pages (sannysoft, browserscan,
creepjs, fingerprint.com playground) and three real protected pages (Indeed,
Cloudflare; Zillow, PerimeterX; Etsy, DataDome). A page passes when status is
200, the title is not a block page and the body has more than 800 chars of text.

## Results

| tool | sannysoft | browserscan | creepjs | fingerprint.com | indeed (CF) | zillow (PX) | etsy (DataDome) | peak PSS | disk |
|---|---|---|---|---|---|---|---|---|---|
| Fetcher (curl_cffi, `impersonate=chrome`) | n/a, no JS | n/a | n/a | n/a | fail 403 | pass | fail 403 | 69 MB | 375 MB venv |
| StealthyFetcher (patchright Chromium 156) | fail (SwiftShader WebGL row) | pass | fail (headless 33%, like headless 50%) | pass | pass, Turnstile solved in 95 s | pass | fail 403 | 2066 MB | +681 MB browsers |
| StealthyFetcher over CDP to CloakBrowser | pass | pass | pass (0% headless, 19% like) | pass | fail 403 after 3 Turnstile tries (248 s) | fail 403 | fail 403 | 1059 MB | uses CloakBrowser |
| CloakBrowser alone (Conclave's launch flags) | pass | pass | pass (0% headless, 25% like) | fail (`chromium_automation`) | fail 403 | pass | fail 403 | 1030 MB | 697 MB |

Fixed per-page waits were 6 to 25 s on detection pages and 10 s on real pages;
StealthyFetcher's overhead past the wait was 5 to 26 s per page. Launch was 0.6 s
(StealthyFetcher), 0.4 s (CDP attach), 0.6 s (CloakBrowser).

Fetcher verdicts on the four detection pages are meaningless (static HTML, no
JS runs) and are scored n/a. One harness quirk: the Fetcher Zillow verdict line
in `summary.json` says fail, but the saved page is a real listing page (1,299
results, 1382 chars, no block title), so it is counted pass here.

Etsy (DataDome) blocked every mode, including CloakBrowser alone.

MCP server: `scrapling mcp` over stdio starts in 1.2 s and lists 16 tools
(`browser_open`, `browser_fetch`, `browser_fetch_once`, `make_request`,
`browser_extract`, `browser_actions`, `browser_evaluate`,
`browser_network_requests`, `browser_screenshot`, session tools, state
save/load; see `results/mcp.json`). Scrapling 0.5 has only Fetcher and
StealthyFetcher; DynamicFetcher is gone.

## Verdict

Keep the catalog entry, opt-in, as shipped.

- The plain Fetcher is the cheap default: 69 MB, sub-5 s pages, and it passed
  Zillow where CloakBrowser's flag set fails fingerprint.com. No browser
  download.
- StealthyFetcher is the only mode that passed Indeed (Turnstile solved
  unattended) but costs 681 MB of bundled patchright browsers and peaks near
  2 GB RAM, too heavy for the hub to run beside much else; it stays opt-in per
  call.
- Handing StealthyFetcher to CloakBrowser over CDP passes every fingerprint
  page but fails the real sites, so the `cdp_url` route is not worth offering.
- CloakBrowser alone stays the stealth answer for the built-in browser, with
  its known fingerprint.com `chromium_automation` gap.

## Rerunning

```sh
cd ~/bench-browsers/scrapling
export TMPDIR=$PWD/tmp XDG_CACHE_HOME=$PWD/cache PLAYWRIGHT_BROWSERS_PATH=$PWD/ms-playwright CLOAKBROWSER_AUTO_UPDATE=false
./run.sh fetcher stealthy stealthy_cdp_cloak cloak_baseline   # one at a time, behind the load gate
venv/bin/python mcp_check.py                                   # stdio startup and tool list
```

CloakBrowser is the hub's pinned install
(`/var/lib/conclave/browser/cloakbrowser/chromium-146.0.7680.177.5/chrome`).
No stored earlier results for Camoufox, Patchright standalone or Lightpanda
were found on disk, so CloakBrowser is the only earlier-round baseline.
