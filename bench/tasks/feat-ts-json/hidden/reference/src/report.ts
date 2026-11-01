/** Monthly report: totals per category and for the month. */
import { currencyInfo } from './currency';
import { formatDate, monthKey } from './dates';
import type { Entry } from './entry';
import { filterEntries, sortEntries } from './filter';
import { sumCents } from './money';

export interface CategoryTotal {
  name: string;
  totalCents: number;
  count: number;
}

export interface Report {
  month: string;
  currency: string;
  totalCents: number;
  categories: CategoryTotal[];
  entries: Entry[];
}

export function buildReport(entries: Entry[], opts: { month: string; currency: string; category?: string }): Report {
  const picked = sortEntries(filterEntries(entries, { month: opts.month, category: opts.category }));
  const byCategory = new Map<string, Entry[]>();
  for (const e of picked) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  const categories = [...byCategory.entries()]
    .map(([name, list]) => ({ name, totalCents: sumCents(list.map((e) => e.amountCents)), count: list.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    month: opts.month,
    currency: opts.currency.toUpperCase(),
    totalCents: sumCents(picked.map((e) => e.amountCents)),
    categories,
    entries: picked,
  };
}

/** Months that have entries, oldest first. */
export function monthsWithEntries(entries: Entry[]): string[] {
  return [...new Set(entries.map((e) => monthKey(e.date)))].sort();
}

function fmt(cents: number, currency: string): string {
  const info = currencyInfo(currency);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${info.symbol}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function renderReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`Report for ${r.month} (${r.currency})`);
  lines.push('');
  const width = Math.max(8, ...r.categories.map((c) => c.name.length));
  for (const c of r.categories) {
    lines.push(`  ${c.name.padEnd(width)}  ${fmt(c.totalCents, r.currency).padStart(14)}  ${c.count} ${c.count === 1 ? 'entry' : 'entries'}`);
  }
  if (r.categories.length) lines.push('');
  lines.push(`  ${'Total'.padEnd(width)}  ${fmt(r.totalCents, r.currency).padStart(14)}  ${r.entries.length} ${r.entries.length === 1 ? 'entry' : 'entries'}`);
  return lines.join('\n') + '\n';
}

/** The report as plain JSON data, with snake_case keys. */
export function reportToJson(r: Report) {
  return {
    month: r.month,
    currency: r.currency,
    total_cents: r.totalCents,
    categories: r.categories.map((c) => ({ name: c.name, total_cents: c.totalCents, count: c.count })),
    entries: r.entries.map((e) => ({ date: formatDate(e.date), description: e.description, amount_cents: e.amountCents, category: e.category })),
  };
}

export function renderEntryLine(e: Entry, currency: string): string {
  return `${formatDate(e.date)}  ${fmt(e.amountCents, currency).padStart(12)}  ${e.category.padEnd(12)}  ${e.description}`;
}
