/**
 * The program block catalog (docs/design/VISUAL-PROGRAMMING.md 4.3), phase 1:
 * one table the parser, the edit ops, GET /api/graph/nodes?use=program and
 * the canvas all read. A block is `const <id> = await <helper>({ ... })` with
 * one key per input; the helpers live in flows/lib/index.ts (flows/lib.ts).
 * Port types (`type`, `gives`) follow what each helper reads and returns in
 * flows/lib-source.js; an input or output with none takes anything.
 */
import type { FlowBlockSpec, FlowPortType } from '../client/flows';

const text = (name: string, def: string, help?: string, type: FlowPortType = 'text') => ({ name, widget: 'text' as const, default: def, type, ...(help ? { help } : {}) });
const list = (name: string) => ({ name, widget: 'text' as const, default: '', type: 'list' as const });
const any = (name: string, def = '') => ({ name, widget: 'text' as const, default: def });
const combo = (name: string, options: string[], def: string) => ({ name, widget: 'combo' as const, default: def, options });

export const FLOW_BLOCKS: FlowBlockSpec[] = [
  { block: 'value', helper: '', title: 'Value', help: 'One text, number or yes/no value', family: 'Inputs', inputs: [text('value', '')], output: true, gives: 'text' },
  { block: 'readFile', helper: 'readFile', title: 'Read file', help: 'Read a file in the project, as text or JSON', family: 'Inputs', inputs: [text('path', 'in.txt'), combo('as', ['text', 'json'], 'text')], output: true, givesBy: { input: 'as', types: { text: 'text', json: 'any' } } },
  { block: 'fetchUrl', helper: 'fetchUrl', title: 'Fetch URL', help: 'Get a web page or API, as text or JSON', family: 'Libraries', inputs: [text('url', 'https://example.com'), combo('as', ['json', 'text'], 'json'), combo('method', ['GET', 'POST'], 'GET')], output: true, givesBy: { input: 'as', types: { text: 'text', json: 'any' } } },
  { block: 'parseJson', helper: 'parseJson', title: 'Parse JSON', help: 'Turn JSON text into data', family: 'Data', inputs: [text('text', '')], output: true },
  { block: 'pick', helper: 'pick', title: 'Pick field', help: 'One field of a record, such as data.items', family: 'Data', inputs: [any('from'), text('field', 'items')], output: true },
  { block: 'map', helper: 'map', title: 'Map', help: 'One field from each item of a list', family: 'Data', inputs: [list('items'), text('field', 'title')], output: true, gives: 'list' },
  {
    block: 'filter',
    helper: 'filter',
    title: 'Filter',
    help: 'Keep the items whose field matches',
    family: 'Data',
    inputs: [list('items'), text('field', 'title'), combo('op', ['contains', '==', '!=', '>', '<'], 'contains'), text('value', '')],
    output: true,
    gives: 'list',
  },
  { block: 'joinText', helper: 'joinText', title: 'Join text', help: 'A list as one text, one item per line', family: 'Data', inputs: [list('items'), text('sep', '\n')], output: true, gives: 'text' },
  { block: 'regex', helper: 'regex', title: 'Regex', help: 'Find matches of a pattern in text', family: 'Data', inputs: [text('text', ''), text('pattern', '\\d+'), text('flags', 'g'), { name: 'many', widget: 'toggle', default: true }], output: true, givesBy: { input: 'many', types: { true: 'list', false: 'text' } } },
  { block: 'writeFile', helper: 'writeFile', title: 'Write file', help: 'Save text to a file in the project', family: 'Outputs', inputs: [text('path', 'out/out.txt'), any('text')], output: true, gives: 'text' },
  { block: 'writeCsv', helper: 'writeCsv', title: 'Write CSV', help: 'Save a list of records as a CSV file', family: 'Outputs', inputs: [text('path', 'out/rows.csv'), list('rows'), text('columns', 'title, url', 'Column names, comma separated')], output: true, gives: 'text' },
  { block: 'log', helper: 'log', title: 'Log', help: 'Print a value in the run output', family: 'Outputs', inputs: [any('value')], output: false },
  { block: 'ai', helper: 'ai', title: 'Call AI', help: "Ask a model through this hub's gateway", family: 'AI', inputs: [text('prompt', 'Summarize this in three lines.'), any('input'), combo('model', ['fast', 'smart', 'deep'], 'fast')], output: true, ownerOnly: true, gives: 'text' },
  { block: 'shell', helper: 'shell', title: 'Shell', help: 'Run a command; gives its stdout and exit code', family: 'Libraries', inputs: [text('command', 'ls')], output: true, gives: 'record' },
];

export const BLOCK_BY_HELPER = new Map(FLOW_BLOCKS.filter((b) => b.helper).map((b) => [b.helper, b]));
export const BLOCK_BY_NAME = new Map(FLOW_BLOCKS.map((b) => [b.block, b]));

/** The variable name a new block of this kind starts from. */
export const BASE_NAME: Record<string, string> = {
  value: 'value',
  readFile: 'file',
  fetchUrl: 'data',
  parseJson: 'parsed',
  pick: 'picked',
  map: 'mapped',
  filter: 'kept',
  joinText: 'joined',
  regex: 'matches',
  writeFile: 'saved',
  writeCsv: 'csv',
  log: 'log',
  ai: 'answer',
  shell: 'out',
};
