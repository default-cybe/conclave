import { expect, test } from 'bun:test';
import { CASES, parityTable, runParity } from '../checks/model-parity';

test('every model gets all ten parity cases on its own wire', async () => {
  const rows = await runParity();
  const failed = rows.flatMap((r) => CASES.filter((c) => !r.results[c].ok).map((c) => `${r.target.label}, ${c}: ${r.results[c].why}`));
  expect(failed).toEqual([]);
  expect(parityTable(rows)).toContain('| GLM-5.3 (Z.ai Coding Plan) | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |');
}, 60_000);
