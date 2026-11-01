/**
 * Calendar dates. A ledger date is a calendar day ("2026-03-31") with no
 * time zone.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

export function parseDate(s: string): Date {
  const text = s.trim();
  if (!DAY.test(text)) throw new Error(`invalid date: ${s}`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`invalid date: ${s}`);
  }
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM" of a day. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function isMonth(s: string): boolean {
  const m = MONTH.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** The first and the last day of a month. */
export function monthRange(month: string): { start: Date; end: Date } {
  const m = MONTH.exec(month);
  if (!m || !isMonth(month)) throw new Error(`invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 0) };
}
