/**
 * CSV importer. The first line is a header with the columns date,
 * description, amount and category, in any order. Fields may be quoted with
 * double quotes; a doubled quote inside a quoted field is a literal quote.
 */
import { parseDate } from '../dates';
import type { Entry } from '../entry';

const REQUIRED = ['date', 'description', 'amount', 'category'];

/** Amount column to cents. Drops a currency sign and thousands commas. */
function amountToCents(raw: string): number {
  const n = parseFloat(raw.replace(/[$€£¥,]/g, ''));
  if (Number.isNaN(n)) throw new Error(`invalid amount: ${raw}`);
  return Math.round(n * 100);
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quoted) throw new Error('unterminated quote');
  out.push(cur);
  return out;
}

export function parseCsv(text: string): Entry[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  for (const col of REQUIRED) {
    if (!header.includes(col)) throw new Error(`missing column: ${col}`);
  }
  const at = (row: string[], col: string) => (row[header.indexOf(col)] ?? '').trim();
  const entries: Entry[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row: string[];
    try {
      row = splitCsvLine(lines[i]);
    } catch (e) {
      throw new Error(`line ${i + 1}: ${(e as Error).message}`);
    }
    try {
      entries.push({
        date: parseDate(at(row, 'date')),
        description: at(row, 'description'),
        amountCents: amountToCents(at(row, 'amount')),
        category: at(row, 'category') || 'uncategorized',
      });
    } catch (e) {
      throw new Error(`line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return entries;
}
