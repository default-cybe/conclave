/**
 * Calendar dates. A ledger date is a calendar day ("2026-03-31") with no
 * time zone. Internally a day is a Date at local midnight.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

export function parseDate(s: string): Date {
  const m = DAY.exec(s.trim());
  if (!m) throw new Error(`invalid date: ${s}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new Error(`invalid date: ${s}`);
  }
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM" of a day. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function isMonth(s: string): boolean {
  const m = MONTH.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** The days of a month as [start, end): start is the 1st, end is the 1st of the next month. */
export function monthRange(month: string): { start: Date; end: Date } {
  const m = MONTH.exec(month);
  if (!m || !isMonth(month)) throw new Error(`invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}
