import { currencyInfo } from './currency';

/**
 * Money helpers. Amounts are integers in cents. Parsing never goes through
 * floating point, so "0.29" is exactly 29 cents.
 */

const AMOUNT = /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a user-written amount into cents.
 *
 * Accepted forms: "12", "12.3", "12.30", "-12.30", "+12.30", "1,234.56",
 * a leading currency symbol ("$12.30", "€5") and accounting negatives
 * in parentheses ("(12.30)" is -1230).
 */
export function parseAmount(input: string): number {
  let s = input.trim();
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^([+-]?)[$€£¥]/, '$1');
  const m = AMOUNT.exec(s);
  if (!m) throw new Error(`invalid amount: ${input}`);
  const [, sign, whole, frac = ''] = m;
  if (sign === '-') negative = !negative;
  const cents = Number(whole.replaceAll(',', '')) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function sumCents(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error(`not a whole number of cents: ${v}`);
    total += v;
  }
  return total;
}

/** Plain decimal form without symbol or grouping, as used in CSV files: 123456 -> "1234.56". */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Amount for people to read: sign, symbol, then the number with the locale's
 * grouping and the currency's own number of decimals.
 */
export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  const info = currencyInfo(currency);
  const units = Math.abs(cents) / 100;
  const digits = units.toLocaleString(locale, { minimumFractionDigits: info.decimals, maximumFractionDigits: info.decimals, useGrouping: true });
  return `${cents < 0 ? '-' : ''}${info.symbol}${digits}`;
}
