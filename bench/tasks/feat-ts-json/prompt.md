Add `--format json` to `ledgerkit report`.

- The JSON is one object: `{"month", "currency", "total_cents", "categories": [{"name", "total_cents", "count"}], "entries": [{"date", "description", "amount_cents", "category"}]}`. `date` is `YYYY-MM-DD`. Amounts are integer cents. Categories and entries come in the same order as in the text report.
- Text stays the default, and `--format text` gives the same output as today.
- Any other value exits with code 2 and prints `unknown format: <value>` to stderr.
- `--month`, `--category` and the currency settings work the same way in both formats.
- Update the help text and the README.
- Add tests.
