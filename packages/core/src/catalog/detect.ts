/**
 * What a repo is, from one tree listing, and how to run it when it is an
 * MCP server (docs/design/ECOSYSTEM.md 1.5). Highest confidence first:
 * server.json, package.json, pyproject.toml, a Dockerfile, then README
 * patterns. The preview always shows the exact result and tests it.
 */
import type { McpServerConfig } from '../config/schema';
import { parseJsonc } from '../config';
import type { CatalogInput, CatalogKind, McpInstall } from './recommended';
import { deriveFromServerJson, type ServerJson } from './registry';

export interface Detection {
  /** Every kind found, most specific first. */
  kinds: CatalogKind[];
  marketplace?: string;
  /** Plugin manifest path, when the repo is one plugin. */
  pluginManifest?: string;
  /** Folders that hold a SKILL.md ("" for the repo root). */
  skills: string[];
  agents: string[];
  commands: string[];
  serverJson: string[];
  packageJson?: string;
  pyproject?: string;
  dockerfile?: string;
  hooksOnly: boolean;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Kind detection with the `npx skills` rules for SKILL.md and the plugin and MCP markers. */
export function detectKinds(paths: string[], read?: (path: string) => string | undefined): Detection {
  const set = new Set(paths);
  const kinds: CatalogKind[] = [];
  const add = (k: CatalogKind) => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  const d: Detection = { kinds, skills: [], agents: [], commands: [], serverJson: [], hooksOnly: false };

  if (set.has('.claude-plugin/marketplace.json')) {
    d.marketplace = '.claude-plugin/marketplace.json';
    add('plugin');
  }
  for (const m of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    if (set.has(m)) {
      d.pluginManifest = m;
      add('plugin');
      break;
    }
  }

  d.serverJson = paths.filter((p) => /(^|\/)server\.json$/.test(p) && p.split('/').length <= 3 && !p.includes('node_modules/'));
  if (set.has('package.json')) d.packageJson = 'package.json';
  if (set.has('pyproject.toml')) d.pyproject = 'pyproject.toml';
  if (set.has('Dockerfile')) d.dockerfile = 'Dockerfile';
  const depends = (file: string | undefined, re: RegExp) => !!file && !!read && re.test(read(file) ?? '');
  if (
    d.serverJson.length ||
    depends(d.packageJson, /"@modelcontextprotocol\/sdk"|"fastmcp"/) ||
    depends(d.pyproject, /["'\s](mcp|fastmcp)(\[[^\]]*\])?\s*([<>=~!]|["'])/)
  )
    add('mcp');

  for (const p of paths) {
    if (!p.endsWith('SKILL.md')) continue;
    const parts = p.split('/');
    const folder = dirOf(p);
    const depth = parts.length - 1;
    const ok =
      p === 'SKILL.md' ||
      (parts[0] === 'skills' && depth <= 4) ||
      p.startsWith('.claude/skills/') ||
      p.startsWith('.agents/skills/') ||
      (depth === 1 && !folder.startsWith('.')) ||
      /^plugins\/[^/]+\/skills\//.test(p);
    if (ok && !d.skills.includes(folder)) d.skills.push(folder);
  }
  if (d.skills.length) add('skill');

  const frontmatter = (p: string) => {
    if (!read) return true;
    const head = (read(p) ?? '').slice(0, 2000);
    return /^---[\s\S]*?\bname:\s*\S[\s\S]*?\bdescription:\s*\S[\s\S]*?---/m.test(head);
  };
  d.agents = paths.filter((p) => /^(\.claude\/)?agents\/[^/]+\.md$/.test(p) && !/readme\.md$/i.test(p) && frontmatter(p));
  if (d.agents.length) add('subagent');
  d.commands = paths.filter((p) => /^(\.claude\/)?commands\/.+\.md$/.test(p) && !/readme\.md$/i.test(p));
  if (d.commands.length) add('command');

  if (set.has('hooks/hooks.json') && !kinds.length) {
    d.hooksOnly = true;
    add('plugin');
  }
  return d;
}

// ---------------------------------------------------------------------------
// MCP config from repo files
// ---------------------------------------------------------------------------

export interface DerivedMcp {
  spec: McpInstall;
  inputs: CatalogInput[];
  /** Where it came from, shown in the preview. */
  from: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

const PLACEHOLDER = /^(YOUR_[A-Z0-9_]*|your[-_].*|<[^>]+>|x{3,}|.*\*{3,}.*|\$\{?[A-Z_][A-Z0-9_]*\}?|.*_HERE|changeme|\.\.\.)$/i;

/** Turn values that look like "YOUR_TOKEN" or "<api key>" into required secret inputs. */
function placeholders(cfg: McpServerConfig, server: string): { config: McpServerConfig; inputs: CatalogInput[] } {
  const inputs: CatalogInput[] = [];
  const mk = (key: string) => {
    const name = key.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
    if (!inputs.some((i) => i.name === name)) {
      inputs.push({ name, label: key, description: `Value for ${key}.`, required: true, secret: true, secretKey: `${server}.${name}`.toLowerCase() });
    }
    return `{{${name}}}`;
  };
  const fix = (rec?: Record<string, string>) => {
    if (!rec) return rec;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      const bearer = /^Bearer\s+(.+)$/i.exec(v);
      if (bearer && PLACEHOLDER.test(bearer[1])) out[k] = `Bearer ${mk(k === 'Authorization' ? 'TOKEN' : k)}`;
      else out[k] = PLACEHOLDER.test(v) || v === '' ? mk(k) : v;
    }
    return out;
  };
  return { config: { ...cfg, env: fix(cfg.env), headers: fix(cfg.headers) }, inputs };
}

function clean(cfg: Record<string, unknown>): McpServerConfig | undefined {
  const out: McpServerConfig = {};
  if (typeof cfg.command === 'string') out.command = cfg.command;
  if (Array.isArray(cfg.args)) out.args = cfg.args.map(String);
  if (typeof cfg.url === 'string') out.url = cfg.url;
  else if (typeof cfg.serverUrl === 'string') out.url = cfg.serverUrl;
  if (cfg.env && typeof cfg.env === 'object') out.env = Object.fromEntries(Object.entries(cfg.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  if (cfg.headers && typeof cfg.headers === 'object') out.headers = Object.fromEntries(Object.entries(cfg.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const type = cfg.type ?? cfg.transport;
  if (type === 'sse') out.type = 'sse';
  else if (out.url) out.type = 'http';
  if (!out.command && !out.url) return undefined;
  return out;
}

/** Split a shell line into words: quotes, backslash escapes, no expansion. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      any = true;
    } else if (c === '\\' && i + 1 < line.length) {
      const n = line[++i];
      if (n !== '\n') cur += n;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Parse "claude mcp add", "codex mcp add" or "gemini mcp add" lines. */
export function parseMcpAddLine(line: string): { name: string; config: McpServerConfig } | undefined {
  const words = shellWords(line.replace(/\\\n/g, ' '));
  const at = words.findIndex((w, i) => (w === 'claude' || w === 'codex' || w === 'gemini') && words[i + 1] === 'mcp' && words[i + 2] === 'add');
  if (at < 0) return undefined;
  const rest = words.slice(at + 3);
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let transport: string | undefined;
  const pos: string[] = [];
  let cmd: string[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '--') {
      cmd = rest.slice(i + 1);
      break;
    }
    if (w === '-e' || w === '--env') {
      const kv = rest[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (w.startsWith('--env=')) {
      const kv = w.slice(6);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (w === '-t' || w === '--transport') transport = rest[++i];
    else if (w.startsWith('--transport=')) transport = w.slice(12);
    else if (w === '-H' || w === '--header') {
      const hv = rest[++i] ?? '';
      const c = hv.indexOf(':');
      if (c > 0) headers[hv.slice(0, c).trim()] = hv.slice(c + 1).trim();
    } else if (w === '-s' || w === '--scope') i++;
    else if (w.startsWith('-') && !pos.length) continue;
    else pos.push(w);
  }
  const name = pos.shift();
  if (!name) return undefined;
  const config: McpServerConfig = {};
  if (cmd?.length) {
    config.command = cmd[0];
    config.args = cmd.slice(1);
  } else if (pos.length && /^https?:\/\//.test(pos[0])) {
    config.url = pos[0];
    config.type = transport === 'sse' ? 'sse' : 'http';
  } else if (pos.length) {
    config.command = pos[0];
    config.args = pos.slice(1);
  } else return undefined;
  if (Object.keys(env).length) config.env = env;
  if (Object.keys(headers).length) config.headers = headers;
  return { name, config };
}

/** mcpServers JSON blocks, CLI add lines and VS Code install links in a README. */
export function mcpFromReadme(readme: string): Array<{ name: string; config: McpServerConfig; from: string }> {
  const out: Array<{ name: string; config: McpServerConfig; from: string }> = [];
  for (const m of readme.matchAll(/```(?:json|jsonc|json5)?\s*\n([\s\S]*?)```/g)) {
    let data: Record<string, unknown> | undefined;
    try {
      data = parseJsonc<Record<string, unknown>>(m[1]);
    } catch {
      continue;
    }
    const servers = (data?.mcpServers ?? (data?.mcp as Record<string, unknown> | undefined)?.servers ?? data?.servers) as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, cfg] of Object.entries(servers)) {
      const c = cfg && typeof cfg === 'object' ? clean(cfg as Record<string, unknown>) : undefined;
      if (c) out.push({ name, config: c, from: 'an mcpServers block in the README' });
    }
  }
  for (const m of readme.matchAll(/^[ \t>$]*((?:claude|codex|gemini) mcp add[^\n]*(?:\\\n[^\n]*)*)/gm)) {
    const p = parseMcpAddLine(m[1]);
    if (p) out.push({ ...p, from: `a "${m[1].split(' ')[0]} mcp add" line in the README` });
  }
  for (const m of readme.matchAll(/vscode\.dev\/redirect\/mcp\/install\?([^\s)"'\]]+)/g)) {
    try {
      const params = new URLSearchParams(m[1]);
      const cfg = JSON.parse(params.get('config') ?? '{}') as Record<string, unknown>;
      const c = clean(cfg);
      if (c) out.push({ name: params.get('name') ?? 'server', config: c, from: 'a VS Code install link in the README' });
    } catch {
      /* not a config link */
    }
  }
  for (const m of readme.matchAll(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?([^\s)"'\]]+)/g)) {
    try {
      const params = new URLSearchParams(m[1]);
      const cfg = JSON.parse(Buffer.from(params.get('config') ?? '', 'base64').toString('utf8')) as Record<string, unknown>;
      const c = clean(cfg);
      if (c) out.push({ name: params.get('name') ?? 'server', config: c, from: 'a Cursor install link in the README' });
    } catch {
      /* not a config link */
    }
  }
  return out;
}

/** Read [project] name and [project.scripts] from a pyproject.toml (no full TOML parser needed). */
export function pyprojectScripts(text: string): { name?: string; scripts: string[] } {
  let section = '';
  let name: string | undefined;
  const scripts: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = /^("?)([\w.-]+)\1\s*=\s*["']([^"']*)["']/.exec(line);
    if (!kv) continue;
    if (section === 'project' && kv[2] === 'name') name = kv[3];
    if (section === 'project.scripts') scripts.push(kv[2]);
  }
  return { name, scripts };
}

export interface RepoFiles {
  repo: string;
  read: (path: string) => string | undefined;
  paths: string[];
  readme?: string;
  /** Checks a package name against its registry (repository field must match). */
  npmMatches?: (pkg: string) => Promise<boolean | null>;
  pypiMatches?: (pkg: string) => Promise<boolean | null>;
}

const slugName = (s: string) => s.replace(/^@[^/]+\//, '').replace(/[-_]?mcp[-_]?(server)?$/i, '').replace(/^mcp[-_]/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || 'server';

/** Every way found to run the repo as an MCP server, best first. */
export async function deriveMcpFromRepo(f: RepoFiles): Promise<DerivedMcp[]> {
  const out: DerivedMcp[] = [];
  const repoName = f.repo.split('/')[1] ?? 'server';
  const server = slugName(repoName).toLowerCase();

  for (const p of [...f.paths.filter((x) => x === 'server.json'), ...f.paths.filter((x) => x !== 'server.json' && /(^|\/)server\.json$/.test(x))]) {
    try {
      const s = JSON.parse(f.read(p) ?? '') as ServerJson;
      if (!s?.name) continue;
      const d = deriveFromServerJson(s, server);
      if (!d) continue;
      for (const spec of [d.install, ...d.variants]) out.push({ spec, inputs: d.inputs, from: p, confidence: 'high', warnings: d.warnings });
      break;
    } catch {
      /* not a server.json */
    }
  }

  if (f.paths.includes('package.json')) {
    try {
      const pkg = JSON.parse(f.read('package.json') ?? '') as { name?: string; version?: string; bin?: string | Record<string, string>; private?: boolean };
      if (pkg.name && pkg.bin && !pkg.private) {
        const ok = f.npmMatches ? await f.npmMatches(pkg.name) : null;
        if (ok !== false) {
          out.push({
            spec: { type: 'mcp', server, label: 'npx on the hub', config: { command: 'npx', args: ['-y', pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name] } },
            inputs: [],
            from: 'package.json',
            confidence: ok ? 'high' : 'medium',
            warnings: ok ? [] : ['The npm package was not checked against this repo.'],
          });
        }
      }
    } catch {
      /* bad package.json */
    }
  }

  if (f.paths.includes('pyproject.toml')) {
    const { name, scripts } = pyprojectScripts(f.read('pyproject.toml') ?? '');
    if (name && scripts.length) {
      const ok = f.pypiMatches ? await f.pypiMatches(name) : null;
      if (ok !== false) {
        const exe = scripts.find((s) => /mcp|server/i.test(s)) ?? scripts[0];
        const args = exe === name ? [name] : ['--from', name, exe];
        out.push({
          spec: { type: 'mcp', server, label: 'uvx on the hub', config: { command: 'uvx', args } },
          inputs: [],
          from: 'pyproject.toml',
          confidence: ok ? 'high' : 'medium',
          warnings: ok ? [] : ['The PyPI package was not checked against this repo.'],
        });
      }
    }
  }

  if (f.paths.includes('Dockerfile')) {
    const text = f.read('Dockerfile') ?? '';
    const labelled = /io\.modelcontextprotocol\.server\.name/.test(text);
    const image = `ghcr.io/${f.repo.toLowerCase()}`;
    if (labelled || (f.readme ?? '').includes(image)) {
      out.push({
        spec: { type: 'mcp', server, label: 'Docker on the hub', config: { command: 'docker', args: ['run', '-i', '--rm', image] } },
        inputs: [],
        from: 'Dockerfile',
        confidence: labelled ? 'medium' : 'low',
        warnings: ['The image tag is latest. Pin a version in the config after the test passes.'],
      });
    }
  }

  if (f.readme) {
    for (const r of mcpFromReadme(f.readme)) {
      const { config, inputs } = placeholders(r.config, server);
      out.push({ spec: { type: 'mcp', server, label: `From ${r.from}`, config }, inputs, from: r.from, confidence: 'low', warnings: ['Read from the README. Check the command before you add it.'] });
    }
  }

  // drop exact duplicates, keep the first (highest confidence)
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = JSON.stringify(d.spec.config);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
