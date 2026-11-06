/**
 * The files Conclave writes into a project for flows
 * (docs/design/VISUAL-PROGRAMMING.md 4.1 and 5.5): flows/lib/index.ts, written
 * once and never overwritten, and the starter of a new flow.
 */
import libSource from './lib-source.js' with { type: 'text' };

/** flows/lib/index.ts. Plain JavaScript, which is valid TypeScript, so it runs with no build step and reads easily. */
export const LIB_SOURCE: string = libSource;

/** Flow names: lowercase words with dashes, so the path and the run command need no quoting. */
export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A flow with no blocks yet (Canvas's New): one comment line, valid and empty; the first insert adds the import. */
export function blankFlow(name: string): string {
  return `// Flow "${name}". Conclave draws this file as blocks (.conclave/graph/${name}.json); edit it as code or as blocks.\n`;
}

export function flowTemplate(name: string): string {
  return `// Flow "${name}". Conclave draws this file as blocks (.conclave/graph/${name}.json); edit it as code or as blocks.
import { readFile, writeFile, fetchUrl, parseJson, pick, map, filter, joinText, regex, writeCsv, log, shell } from './lib';

const url = 'https://api.github.com/repos/oven-sh/bun';
const data = await fetchUrl({ url, as: 'json', method: 'GET' });
const stars = await pick({ from: data, field: 'stargazers_count' });
await log({ value: stars });
`;
}
