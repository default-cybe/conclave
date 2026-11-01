/** Monthly report: totals per category and for the month. */
import { formatDate, monthKey } from './dates';
import type { Entry } from './entry';
import { filterEntries, sortEntries } from './filter';
import { formatMoney, sumCents } from './money';

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

export function renderReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`Report for ${r.month} (${r.currency})`);
  lines.push('');
  const width = Math.max(8, ...r.categories.map((c) => c.name.length));
  for (const c of r.categories) {
    lines.push(`  ${c.name.padEnd(width)}  ${formatMoney(c.totalCents, r.currency).padStart(14)}  ${c.count} ${c.count === 1 ? 'entry' : 'entries'}`);
  }
  if (r.categories.length) lines.push('');
  lines.push(`  ${'Total'.padEnd(width)}  ${formatMoney(r.totalCents, r.currency).padStart(14)}  ${r.entries.length} ${r.entries.length === 1 ? 'entry' : 'entries'}`);
  return lines.join('\n') + '\n';
}

export function renderEntryLine(e: Entry, currency: string): string {
  return `${formatDate(e.date)}  ${formatMoney(e.amountCents, currency).padStart(12)}  ${e.category.padEnd(12)}  ${e.description}`;
}
