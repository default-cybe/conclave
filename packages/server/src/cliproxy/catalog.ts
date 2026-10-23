/**
 * The models a ChatGPT plan offers that CLIProxyAPI does not know yet
 * (docs/DESIGN.md 48). CLIProxyAPI lists and routes a ChatGPT plan's models
 * from its own catalog only (models.json, by plan: codex-free, codex-plus,
 * codex-pro, codex-team), which it takes from router-for-me/models every 3
 * hours. A request for any other model ends with "unknown provider for
 * model gpt-6.2-nova" (400, model_not_found), before ChatGPT is asked. An alias
 * cannot help: it only renames a model the catalog has.
 *
 * Its config takes a catalog of our own (models.catalog, an absolute path),
 * and then never reads its own sources. So the hub CLIProxyAPI runs
 * (builtin) gets the same official catalog, read by the hub from the same
 * addresses, with each such model added to the plan's section. The hub
 * writes it as <home>/cliproxy/catalog-<hash>.json and points CLIProxyAPI at
 * it through the management API; with nothing to add it points CLIProxyAPI
 * back at its own sources. An external CLIProxyAPI is the owner's and serves
 * other tools: the hub leaves its catalog alone.
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where CLIProxyAPI reads its catalog (internal/registry/model_updater.go), first that answers. */
export const CATALOG_URLS = ['https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json', 'https://models.router-for.me/models.json'];
/** CLIProxyAPI reads its catalog again this often; the hub does the same. */
export const CATALOG_MS = 3 * 3_600_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** The catalog section of a ChatGPT plan, from the plan in its id token (CLIProxyAPI's own mapping; unknown is Pro). */
export function codexSection(planType: string | undefined): string {
  const p = (planType ?? '').toLowerCase();
  if (p === 'plus') return 'codex-plus';
  if (p === 'free') return 'codex-free';
  if (p === 'team' || p === 'business' || p === 'go') return 'codex-team';
  return 'codex-pro';
}

export type Catalog = Record<string, Array<Record<string, unknown>>>;

/** Throws unless it reads as CLIProxyAPI's models.json: an object of model lists, with the ChatGPT sections. */
export function checkCatalog(v: unknown): Catalog {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the model catalog is not an object');
  const c = v as Record<string, unknown>;
  for (const k of ['codex-free', 'codex-team', 'codex-plus', 'codex-pro']) if (!Array.isArray(c[k])) throw new Error(`the model catalog has no ${k} list`);
  for (const [k, list] of Object.entries(c)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) if (!m || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string') throw new Error(`the model catalog has a model without an id in ${k}`);
  }
  return c as Catalog;
}

/** The official catalog, from the first address that gives a valid one. Throws with the last reason. */
export async function fetchCatalog(f: typeof fetch = fetch, urls: string[] = CATALOG_URLS, timeoutMs = 20_000): Promise<Catalog> {
  let why = 'no address';
  for (const url of urls) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('too big');
      return checkCatalog(JSON.parse(text));
    } catch (err) {
      why = `${new URL(url).host}: ${(err as Error).message}`;
    }
  }
  throw new Error(`could not read CLIProxyAPI's model catalog (${why})`);
}

export interface CatalogExtra {
  /** codex-plus, codex-pro... */
  section: string;
  id: string;
  name?: string;
}

/**
 * The catalog with each extra model added to its section, unless the section
 * has it. An added model copies the capabilities of the section's first
 * model (its newest), since the plan's own list gives only a name. Returns
 * the catalog and what was added.
 */
export function withExtras(base: Catalog, extras: CatalogExtra[]): { catalog: Catalog; added: CatalogExtra[] } {
  const catalog: Catalog = structuredClone(base);
  const added: CatalogExtra[] = [];
  for (const e of extras) {
    const list = catalog[e.section];
    if (!Array.isArray(list) || list.some((m) => m.id === e.id)) continue;
    const like = list[0] ?? { object: 'model', owned_by: 'openai', type: 'openai' };
    // nothing time based in it: the same models give the same file, so CLIProxyAPI is pointed at it once
    list.push({ ...like, id: e.id, display_name: e.name ?? e.id, description: `${e.name ?? e.id}, from the plan's own model list.` });
    added.push(e);
  }
  return { catalog, added };
}

/** Write the catalog under a name from its content, drop the older ones, and return its path. */
export function writeCatalog(dir: string, catalog: Catalog): string {
  const text = JSON.stringify(catalog);
  const name = `catalog-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`;
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  dropCatalogs(dir, name);
  return path;
}

/** Remove the catalog files in dir, except `keep`. */
export function dropCatalogs(dir: string, keep?: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (/^catalog-[0-9a-f]{12}\.json$/.test(n) && n !== keep) rmSync(join(dir, n), { force: true });
}
