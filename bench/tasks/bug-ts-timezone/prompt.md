On my server (TZ=Europe/Berlin) entries from March 31 are missing from the March report. On my laptop they show up. Is the server's data file stale?

The server and the laptop use the same ledger.csv, the one in this folder. On the server I run `bun src/cli.ts report --month 2026-03` and the rent on 2026-03-31 is not in the total. You can see it with `TZ=Europe/Berlin bun src/cli.ts report --month 2026-03`.

Please find out what is going on and fix it. Some of my family run ledgerkit in other time zones too, including the US.
