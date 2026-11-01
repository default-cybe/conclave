# ledgerkit

A small personal ledger for the command line. It reads one CSV file of entries and prints monthly reports, lists and exports. It runs on Bun and has no dependencies.

## Install and run

```
bun src/cli.ts report --month 2026-03
bun test
```

## The ledger file

`ledger.csv` in the current folder, or the file given with `--data`. The first line is a header. Columns may come in any order:

```
date,description,amount,category
2026-03-02,Coffee beans,-14.50,food
2026-03-03,"Rent, March",-950.00,home
2026-03-05,Salary,3200.00,income
```

- `date` is a calendar day, `YYYY-MM-DD`. Days have no time zone: an entry dated 2026-03-31 belongs to March wherever you run ledgerkit.
- `amount` is a signed decimal. ledgerkit accepts the same forms everywhere: `12`, `12.3`, `12.30`, `-12.30`, `+12.30`, `1,234.56`, a leading currency symbol (`$12.30`, `€5`), and accounting negatives in parentheses (`(12.30)` means -12.30). Amounts are kept as whole cents, never as floating point numbers.
- `category` is free text. An empty category becomes `uncategorized`.

## Commands

- `report [--month YYYY-MM] [--category NAME]`: totals per category and for the month. Without `--month`, the latest month with entries.
- `list [--month] [--category] [--search TEXT]`: one line per entry, oldest first.
- `export [--month] [--as csv|md]`: CSV (plain decimals) or a Markdown table.
- `months`: the months that have entries.

## Settings

Settings are `currency` (USD, EUR, GBP or JPY), `data` (the ledger file) and `locale`. Later sources win:

1. built-in defaults (`USD`, `ledger.csv`, `en-US`)
2. `ledgerkit.json` in the current folder, for example `{"currency": "EUR"}`
3. environment variables `LEDGERKIT_CURRENCY`, `LEDGERKIT_DATA`, `LEDGERKIT_LOCALE`
4. command line flags `--currency`, `--data`, `--locale`

`--currency` only changes how amounts are printed. ledgerkit does not convert between currencies.

## Exit codes

0 on success, 1 when the ledger cannot be read, 2 for a usage error.

## Layout

- `src/money.ts` parses amounts and sums cents
- `src/currency.ts` lists the known currencies
- `src/dates.ts` parses days and months
- `src/importers/csv.ts` reads the ledger file
- `src/filter.ts` filters and sorts entries
- `src/report.ts` builds and prints reports
- `src/export.ts` writes CSV and Markdown
- `src/config.ts` merges settings
- `src/cli.ts` is the command line (`main(argv, io)` is exported for tests)
