// a flow with hand-written code between the blocks
import { readFile, map, joinText, regex, writeFile, shell, parseJson } from './lib';

/* settings */
const path = "in/notes.txt";
const limit: number = 3;
const text = await readFile({ path, as: 'text' });
const nums = await regex({ text, pattern: '\\d+', flags: 'g', many: true });
const top = nums.slice(0, limit).map(Number);
function double(x: number) {
  return x * 2;
}
const doubled = top.map(double);
const raw = await shell({ command: `echo '{"a":1}'` });
const parsed = await parseJson({ text: raw.stdout });
const names = await map({ items: doubled, field: 'x' });
const joined = await joinText({ items: names, sep: '\n' });
const saved = await writeFile({ path: `out/${path}`, text: joined });
await writeFile({ path: 'out/b.txt', text: parsed.a });
