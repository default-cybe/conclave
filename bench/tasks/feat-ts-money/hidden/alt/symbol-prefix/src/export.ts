/** Export entries as CSV (for spreadsheets) or as a Markdown table (for notes). */
import { formatDate } from './dates';
import type { Entry } from './entry';
import { centsToDecimal, formatMoney } from './money';

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

function mdCell(s: string): string {
  return s.replaceAll('|', '\\|');
}

export function toMarkdown(entries: Entry[], currency: string): string {
  const rows = ['| Date | Description | Category | Amount |', '|---|---|---|---:|'];
  for (const e of entries) {
    rows.push(`| ${formatDate(e.date)} | ${mdCell(e.description)} | ${mdCell(e.category)} | ${formatMoney(e.amountCents, currency)} |`);
  }
  return rows.join('\n') + '\n';
}
