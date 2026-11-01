/** Export entries as CSV (for spreadsheets) or as a Markdown table (for notes). */
import { currencyInfo } from './currency';
import { formatDate } from './dates';
import type { Entry } from './entry';
import { centsToDecimal } from './money';

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(entries: Entry[]): string {
  const rows = ['date,description,amount,category'];
  for (const e of entries) {
    rows.push([formatDate(e.date), csvField(e.description), centsToDecimal(e.amountCents), csvField(e.category)].join(','));
  }
  return rows.join('\n') + '\n';
}

function formatAmount(cents: number, currency: string): string {
  const info = currencyInfo(currency);
  const negative = cents < 0;
  const units = Math.abs(cents) / 100;
  let text: string;
  if (info.decimals === 0) {
    text = Math.round(units).toString();
  } else {
    const abs = Math.abs(cents);
    text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  }
  const [whole, frac] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${info.symbol}${frac === undefined ? grouped : `${grouped}.${frac}`}`;
}

function mdCell(s: string): string {
  return s.replaceAll('|', '\\|');
}

export function toMarkdown(entries: Entry[], currency: string): string {
  const rows = ['| Date | Description | Category | Amount |', '|---|---|---|---:|'];
  for (const e of entries) {
    rows.push(`| ${formatDate(e.date)} | ${mdCell(e.description)} | ${mdCell(e.category)} | ${formatAmount(e.amountCents, currency)} |`);
  }
  return rows.join('\n') + '\n';
}
