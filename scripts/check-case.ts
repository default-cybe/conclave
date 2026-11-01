/**
 * Fails when two tracked files in one folder clash on macOS and Windows: names
 * that differ only in letter case (Bar.md, bar.md), or code files one
 * extensionless import could load (recipes.ts, Recipes.tsx). Linux keeps them
 * apart, so only a Mac or Windows build would break.
 */
import { execSync } from 'node:child_process';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const seen = new Map<string, string>();
const clashes: string[] = [];
for (const file of files) {
  const key = file.replace(CODE, '').toLowerCase();
  const other = seen.get(key);
  if (other) clashes.push(`${other}  and  ${file}`);
  else seen.set(key, file);
}

if (clashes.length) {
  console.error(`Files that clash on macOS and Windows:\n${clashes.map((c) => `  ${c}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-case: ${files.length} files, no clashes`);
