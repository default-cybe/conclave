/**
 * Feeds read from raw.githubusercontent.com and open registries, so they cost
 * no GitHub API calls: marketplace.json files, the quemsah star index and the
 * awesome-claude-code CSV (docs/design/ECOSYSTEM.md 1.3).
 */
import type { CatalogHttp } from './http';
import { RAW, guessCategory } from './github';
import type { CatalogItem, CatalogKind } from './recommended';

const DAY = 24 * 3_600_000;

export interface MarketplaceJson {
  name?: string;
  owner?: unknown;
  metadata?: { pluginRoot?: string; description?: string; version?: string };
  plugins?: MarketplacePlugin[];
}

export interface MarketplacePlugin {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  keywords?: string[];
  tags?: string[];
  author?: { name?: string } | string;
  homepage?: string;
  license?: string;
  source: string | { source: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
  strict?: boolean;
  skills?: string[] | string;
  agents?: string[] | string;
  commands?: string[] | string;
  hooks?: unknown;
  mcpServers?: unknown;
}

/** raw.githubusercontent.com URL of a repo's marketplace.json at a ref. */
export function marketplaceUrl(repo: string, ref = 'HEAD'): string {
  return `${RAW}/${repo}/${ref}/.claude-plugin/marketplace.json`;
}

export async function readMarketplace(http: CatalogHttp, repo: string, ref = 'HEAD'): Promise<MarketplaceJson | undefined> {
  // a commit sha never changes, so its copy is kept forever
  const ttlMs = /^[0-9a-f]{40}$/.test(ref) ? Infinity : DAY;
  const { data } = await http.json<MarketplaceJson>(marketplaceUrl(repo, ref), { ttlMs, maxBytes: 5_000_000 });
  return data && Array.isArray(data.plugins) ? data : undefined;
}

/** Where a marketplace entry's files live. */
export interface EntrySource {
  /** owner/repo or a full git URL. */
  repo?: string;
  url: string;
  /** Folder inside the repo ("" for the root). */
  path: string;
  ref?: string;
  sha?: string;
  /** The files live in the marketplace repo itself. */
  local: boolean;
}

/**
 * A git URL from someone else's marketplace.json that the hub may fetch:
 * https, or ssh to a host. Not local paths or file:// (they would read the
 * hub's own disk), and not ext:: or fd:: transports (they run commands).
 */
export function safeGitUrl(url: string): boolean {
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/.test(url)) return true;
  if (/^ssh:\/\/[\w.-]+@[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/.test(url)) return true;
  return /^[\w.-]+@[A-Za-z0-9.-]+:[\w./-]+$/.test(url) && !url.includes('..');
}

export function resolveEntrySource(entry: MarketplacePlugin, marketplaceRepo: string, pluginRoot?: string): EntrySource {
  const src = entry.source;
  if (typeof src === 'string') {
    const rel = src === '.' || src === './' ? '' : src.replace(/^\.\//, '').replace(/\/+$/, '');
    const root = (pluginRoot ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
    const path = rel.includes('/') || !root ? rel : root ? `${root}/${rel}` : rel;
    return { repo: marketplaceRepo, url: `https://github.com/${marketplaceRepo}.git`, path, local: true };
  }
  const kind = src.source;
  const path = (src.path ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (kind === 'github' && src.repo) return { repo: src.repo, url: `https://github.com/${src.repo}.git`, path, ref: src.ref, sha: src.sha, local: false };
  const raw = String(src.url ?? src.repo ?? '');
  const url = raw.includes('://') || raw.startsWith('git@') ? raw : `https://github.com/${raw}.git`;
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(url);
  return { repo: m?.[1], url, path, ref: src.ref, sha: src.sha, local: false };
}

/** Each entry of a marketplace as a "mkt:<plugin>@<marketplace>" item. */
export function marketplaceItems(mk: MarketplaceJson, repo: string, at: number): CatalogItem[] {
  const name = mk.name ?? repo.split('/')[1];
  const out: CatalogItem[] = [];
  for (const p of mk.plugins ?? []) {
    if (!p?.name) continue;
    const src = resolveEntrySource(p, repo, mk.metadata?.pluginRoot);
    const tags = [...(p.keywords ?? p.tags ?? [])].slice(0, 6).map(String);
    out.push({
      id: `mkt:${p.name}@${name}`,
      kind: 'plugin',
      name: p.name,
      repo: src.repo ?? repo,
      url: p.homepage,
      description: p.description ?? '',
      category: guessCategory(`${p.name} ${p.description ?? ''} ${p.category ?? ''} ${tags.join(' ')}`),
      tags: [...(p.category ? [p.category] : []), ...tags].slice(0, 6),
      license: p.license,
      install: { type: 'plugin', marketplace: repo, plugins: [`${p.name}@${name}`], ...(src.sha ? { sha: src.sha } : {}) },
      touches: [],
      recommended: false,
      source: 'marketplace',
      verified: false,
      starsAt: new Date(at).toISOString().slice(0, 10),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// quemsah star index
// ---------------------------------------------------------------------------

export interface StarIndexRow {
  repo: string;
  stars: number;
  description: string;
}

/** Plugin repos with 50 or more stars from the quemsah index (repos.json). */
export function parseStarIndex(body: string, minStars = 50): StarIndexRow[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: StarIndexRow[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    const stars = Number(r.stargazers_count ?? 0);
    if (stars < minStars || Number(r.plugins_count ?? 1) < 1) continue;
    const repo = r.owner && r.repo_name ? `${r.owner}/${r.repo_name}` : String(r.html_url ?? '').replace(/^https:\/\/github\.com\//, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    out.push({ repo, stars, description: typeof r.description === 'string' ? r.description : '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// awesome-claude-code CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function csvKind(category: string, sub: string, name: string, repo: string, desc: string): CatalogKind {
  const t = `${category} ${sub} ${name}`.toLowerCase();
  if (/\bmcp\b|-mcp\b|mcp-/.test(repo.toLowerCase()) || /\bmcp server\b/i.test(desc.slice(0, 120))) return 'mcp';
  if (/hook/.test(t)) return 'hook';
  if (/slash|command/.test(t)) return 'command';
  if (/sub-?agent|agent/.test(t) && !/skill/.test(t)) return 'subagent';
  if (/mcp/.test(t)) return 'mcp';
  if (/skill/.test(t)) return 'skill';
  return 'plugin';
}

/** Rows of THE_RESOURCES_TABLE CSV as items (source awesome-list). Only GitHub repos, only active and not stale. */
export function awesomeItems(csv: string): CatalogItem[] {
  const rows = parseCsv(csv);
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => head.indexOf(name);
  const iName = col('display name');
  const iCat = col('category');
  const iSub = col('sub-category');
  const iLink = col('link');
  const iActive = col('active');
  const iDesc = col('description');
  const iStale = col('stale');
  const out: CatalogItem[] = [];
  for (const r of rows) {
    const link = r[iLink]?.trim() ?? '';
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(link);
    if (!m) continue;
    if (iActive >= 0 && r[iActive]?.toUpperCase() === 'FALSE') continue;
    if (iStale >= 0 && r[iStale]?.toUpperCase() === 'TRUE') continue;
    const name = r[iName]?.trim() || m[1].split('/')[1];
    const desc = (r[iDesc] ?? '').trim();
    const kind = csvKind(r[iCat] ?? '', r[iSub] ?? '', name, m[1], desc);
    out.push({
      id: `gh:${m[1]}`,
      kind,
      name,
      repo: m[1],
      url: link,
      description: desc.length > 400 ? `${desc.slice(0, 397)}...` : desc,
      category: guessCategory(`${name} ${r[iCat] ?? ''} ${r[iSub] ?? ''} ${desc}`),
      tags: [r[iCat], r[iSub]].filter((x): x is string => !!x && !!x.trim()).map((x) => x.trim()),
      install: { type: 'manual', steps: [{ say: 'The preview reads this repo at its latest commit and works out how to add it.' }] },
      touches: [],
      recommended: false,
      source: 'awesome-list',
      verified: false,
    });
  }
  return out;
}
