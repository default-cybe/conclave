Refactor: money formatting is copied in `src/report.ts` and `src/export.ts`, and the copies disagree for JPY.

- Move it into one function in `src/money.ts`: `formatMoney(cents: number, currency: string, locale?: string): string`. `locale` defaults to `en-US`. It sets the digit grouping and the decimal mark: 123456 cents in EUR with the `de-DE` locale is written with `1.234,56`.
- Use it in both places.
- Zero-decimal currencies print without decimals: 120000 cents in JPY is `¥1,200`, in reports and in exports.
- Keep all other output byte for byte the same as today.
- Add tests.
