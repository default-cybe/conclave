import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IO } from '../src/cli';

export const SAMPLE = `date,description,amount,category
2026-02-14,Flowers,-25.00,gifts
2026-03-02,Coffee beans,-14.50,food
2026-03-03,"Rent, March",-950.00,home
2026-03-05,Salary,3200.00,income
2026-03-12,Groceries,-82.25,food
2026-03-20,"Book ""Dune""",-12.75,fun
`;

export function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerkit-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

export function fakeIO(cwd: string, env: Record<string, string | undefined> = {}): IO & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    env,
    cwd,
    stdout: (s: string) => {
      io.out += s;
    },
    stderr: (s: string) => {
      io.err += s;
    },
  };
  return io;
}
