/**
 * MCP registry derivation and the trust rule, replaying the registry
 * responses recorded on 2026-10-17. Also feeds (marketplaces, star index,
 * CSV, Docker) and repo detection.
 */
import { describe, expect, test } from 'bun:test';
import { deriveFromServerJson, namespaceMatches, registryToItem, McpRegistry, type RegistryEntry } from '../../src/catalog/registry';
import { awesomeItems, marketplaceItems, parseCsv, parseStarIndex, resolveEntrySource, type MarketplaceJson } from '../../src/catalog/feeds';
import { detectKinds, deriveMcpFromRepo, mcpFromReadme, parseMcpAddLine, pyprojectScripts, shellWords } from '../../src/catalog/detect';
import { CatalogStore } from '../../src/catalog/store';
import { CatalogHttp } from '../../src/catalog/http';
import { fixtureFetch, fx, fxJson, json, tempHome } from './helpers';

const reg = (name: string) => fxJson<RegistryEntry>(`registry/get_${name}.json`);

describe('server.json derivation', () => {
  test('github-mcp-server: remote first with a bearer token input; docker with the token moved out of args into env', () => {
    const d = deriveFromServerJson(reg('io.github.github__github-mcp-server').server, 'github')!;
    expect(d.install.config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{TOKEN}}' } });
    const docker = d.variants.find((v) => v.config.command === 'docker')!;
    expect(docker.config.args).toContain('ghcr.io/github/github-mcp-server:2.0.2');
    // "-e GITHUB_PERSONAL_ACCESS_TOKEN={token}" becomes "-e GITHUB_PERSONAL_ACCESS_TOKEN" plus env
    expect(docker.config.args!.join(' ')).not.toContain('{{');
    expect(docker.config.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('{{TOKEN}}');
    const tok = d.inputs.find((i) => i.name === 'TOKEN')!;
    expect(tok).toMatchObject({ secret: true, secretKey: 'github.token' });
  });

  test('basic-memory: subcommands in runtimeArguments move after the package', () => {
    const d = deriveFromServerJson(reg('io.github.basicmachines-co__basic-memory').server, 'basic-memory')!;
    expect(d.install.config).toEqual({ command: 'uvx', args: ['basic-memory==0.23.2', 'mcp'] });
    expect(d.warnings.join(' ')).toContain('runtimeArguments');
  });

  test('serena: flags stay before the package, positionals and what follows go after it', () => {
    const d = deriveFromServerJson(reg('io.github.oraios__serena').server, 'serena')!;
    expect(d.install.config.args).toEqual(['-p', '3.13', 'serena-agent==1.5.3', 'start-mcp-server', '--project-from-cwd', '--context', 'desktop-app']);
  });

  test('context7: remote, then npx with the secret in env', () => {
    const d = deriveFromServerJson(reg('io.github.upstash__context7').server, 'context7')!;
    expect(d.install.config.url).toBe('https://mcp.context7.com/mcp');
    const npx = d.variants.find((v) => v.config.command === 'npx')!;
    expect(npx.config).toEqual({ command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.2'], env: { CONTEXT7_API_KEY: '{{CONTEXT7_API_KEY}}' } });
    // mcpb bundles are not run
    expect(d.variants.length).toBe(1);
  });

  test('proxmox: required vars become required inputs, optional ones with no value are left out', () => {
    const d = deriveFromServerJson(reg('io.github.RekklesNA__proxmox-mcp-plus').server, 'pve')!;
    expect(Object.keys(d.install.config.env!).sort()).toEqual(['PROXMOX_HOST', 'PROXMOX_TOKEN_NAME', 'PROXMOX_TOKEN_VALUE', 'PROXMOX_USER']);
    expect(d.inputs.find((i) => i.name === 'PROXMOX_TOKEN_VALUE')).toMatchObject({ required: true, secret: true });
    expect(d.inputs.find((i) => i.name === 'PROXMOX_HOST')).toMatchObject({ required: true, secret: false });
    expect(d.needs.map((n) => n.bin)).toEqual(['uvx']);
  });

  test('chrome-devtools: npx with the pinned version', () => {
    const d = deriveFromServerJson(reg('io.github.ChromeDevTools__chrome-devtools-mcp').server)!;
    expect(d.install.config).toEqual({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0'] });
  });

  test('trust rule: a lookalike namespace is not verified', () => {
    expect(namespaceMatches('io.github.ChromeDevTools/chrome-devtools-mcp', 'https://github.com/ChromeDevTools/chrome-devtools-mcp')).toBe(true);
    expect(namespaceMatches('io.github.chromedevtools/x', 'https://github.com/ChromeDevTools/x.git')).toBe(true);
    expect(namespaceMatches('io.github.secforge/chrome-devtools-mcp', 'https://github.com/ChromeDevTools/chrome-devtools-mcp')).toBe(false);
    const page = fxJson<{ servers: RegistryEntry[] }>('registry/chrome-devtools.json');
    const items = page.servers.map((e) => registryToItem(e, 0)).filter(Boolean);
    const official = items.find((i) => i!.id === 'reg:io.github.ChromeDevTools/chrome-devtools-mcp')!;
    expect(official.risk).toBeUndefined();
    const copies = items.filter((i) => i!.repo === 'ChromeDevTools/chrome-devtools-mcp' && i!.id !== official.id);
    for (const c of copies) expect(c!.risk).toContain('Not verified');
    for (const i of items) expect(i!.verified).toBe(false); // verified only after the preview checks the marker
  });

  test('ownership marker: npm mcpName must equal the registry name', async () => {
    const f = fixtureFetch([
      ['https://registry.npmjs.org/chrome-devtools-mcp/1.11.0', () => json({ name: 'chrome-devtools-mcp', mcpName: 'io.github.ChromeDevTools/chrome-devtools-mcp' })],
      ['https://registry.npmjs.org/@secforge%2Fchrome-devtools-mcp/', () => json({ name: '@secforge/chrome-devtools-mcp', mcpName: 'io.github.secforge/chrome-devtools-mcp' })],
    ]);
    const { db } = tempHome();
    const r = new McpRegistry(new CatalogHttp(new CatalogStore(db), { fetch: f }));
    expect(await r.ownershipMarker({ registryType: 'npm', identifier: 'chrome-devtools-mcp', version: '1.11.0' }, 'io.github.ChromeDevTools/chrome-devtools-mcp')).toBe(true);
    expect(await r.ownershipMarker({ registryType: 'npm', identifier: '@secforge/chrome-devtools-mcp', version: '1.0.0' }, 'io.github.ChromeDevTools/chrome-devtools-mcp')).toBe(false);
    expect(await r.ownershipMarker({ registryType: 'oci', identifier: 'ghcr.io/x/y' }, 'io.github.x/y')).toBeNull();
  });
});

describe('feeds', () => {
  const mk = (n: string) => fxJson<MarketplaceJson>(`marketplaces/${n}`);

  test('marketplace entries become mkt: items with their install source', () => {
    const items = marketplaceItems(mk('DietrichGebert__ponytail@16352ac.json'), 'DietrichGebert/ponytail', 0);
    expect(items.map((i) => i.id)).toEqual(['mkt:ponytail@ponytail']);
    expect(items[0].install).toEqual({ type: 'plugin', marketplace: 'DietrichGebert/ponytail', plugins: ['ponytail@ponytail'] });
    const official = marketplaceItems(mk('anthropics__claude-plugins-official@ea10b21.json'), 'anthropics/claude-plugins-official', 0);
    const sp = official.find((i) => i.name === 'superpowers')!;
    expect(sp.repo).toBe('obra/superpowers');
    expect((sp.install as { sha?: string }).sha).toBe('bb92a77741419a4ab5f06e711a283343f1ada0c3');
  });

  test('entry sources: relative, url with sha, git-subdir, strict false', () => {
    const official = mk('anthropics__claude-plugins-official@ea10b21.json');
    const rel = resolveEntrySource(official.plugins!.find((p) => p.name === 'hookify')!, 'anthropics/claude-plugins-official');
    expect(rel).toMatchObject({ local: true, path: 'plugins/hookify', repo: 'anthropics/claude-plugins-official' });
    const url = resolveEntrySource(official.plugins!.find((p) => p.name === 'superpowers')!, 'anthropics/claude-plugins-official');
    expect(url).toMatchObject({ local: false, repo: 'obra/superpowers', sha: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', path: '' });
    const skills = mk('anthropics__skills@dbd4588.json');
    expect(skills.plugins![0].strict).toBe(false);
    expect(resolveEntrySource(skills.plugins![0], 'anthropics/skills')).toMatchObject({ local: true, path: '' });
  });

  test('star index keeps plugin repos with 50 or more stars', () => {
    const rows = parseStarIndex(fx('feeds/quemsah-repos-top30.json'));
    expect(rows.length).toBe(30);
    expect(rows[0]).toMatchObject({ repo: 'obra/superpowers', stars: 300654 });
    expect(parseStarIndex(JSON.stringify([{ owner: 'a', repo_name: 'b', stargazers_count: 10, plugins_count: 1 }]))).toEqual([]);
  });

  test('awesome-claude-code CSV: quoted fields, GitHub rows only, not stale', () => {
    const csv = fx('feeds/awesome-claude-code.resources@d9b87c2.csv');
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3\n')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    const items = awesomeItems(csv);
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.id.startsWith('gh:') && i.source === 'awesome-list')).toBe(true);
    expect(items.find((i) => i.repo === 'ngmeyer/librarian-mcp')?.kind).toBe('mcp');
  });
});

describe('repo detection', () => {
  test('kinds from a tree: marketplace, plugin, skills by the npx skills rules, agents, commands', () => {
    const d = detectKinds([
      '.claude-plugin/marketplace.json',
      '.claude-plugin/plugin.json',
      'skills/a/SKILL.md',
      'skills/group/b/SKILL.md',
      'ctf-web/SKILL.md',
      'docs/deep/nested/SKILL.md',
      'agents/reviewer.md',
      'agents/README.md',
      'commands/ship.md',
    ]);
    expect(d.kinds).toEqual(['plugin', 'skill', 'subagent', 'command']);
    expect(d.skills.sort()).toEqual(['ctf-web', 'skills/a', 'skills/group/b']);
    expect(d.agents).toEqual(['agents/reviewer.md']);
  });

  test('an MCP server from package.json dependencies and server.json', () => {
    const read = (p: string) => (p === 'package.json' ? '{"name":"x-mcp","bin":{"x":"dist/x.js"},"dependencies":{"@modelcontextprotocol/sdk":"^1"}}' : undefined);
    expect(detectKinds(['package.json', 'src/index.ts'], read).kinds).toEqual(['mcp']);
    expect(detectKinds(['server.json']).kinds).toEqual(['mcp']);
    expect(detectKinds(['hooks/hooks.json']).hooksOnly).toBe(true);
  });

  test('README patterns: mcpServers blocks, claude mcp add lines, VS Code links', () => {
    const readme = [
      '```json',
      '{ "mcpServers": { "notion": { "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"], "env": { "NOTION_TOKEN": "ntn_****" } } } }',
      '```',
      'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer YOUR_TOKEN"',
      'codex mcp add git -e GIT_DIR=/repo -- uvx mcp-server-git --repository .',
      `[Install](https://insiders.vscode.dev/redirect/mcp/install?name=fetch&config=${encodeURIComponent(JSON.stringify({ command: 'uvx', args: ['mcp-server-fetch'] }))})`,
    ].join('\n');
    const found = mcpFromReadme(readme);
    expect(found.map((f) => f.name)).toEqual(['notion', 'sentry', 'git', 'fetch']);
    expect(found[1].config).toEqual({ url: 'https://mcp.sentry.dev/mcp', type: 'http', headers: { Authorization: 'Bearer YOUR_TOKEN' } });
    expect(found[2].config).toEqual({ command: 'uvx', args: ['mcp-server-git', '--repository', '.'], env: { GIT_DIR: '/repo' } });
    expect(shellWords(`a "b c" 'd e' f\\ g`)).toEqual(['a', 'b c', 'd e', 'f g']);
    expect(parseMcpAddLine('claude mcp add x')).toBeUndefined();
  });

  test('derive from repo files: README placeholders become required secret inputs', async () => {
    const files: Record<string, string> = {
      'README.md': '```json\n{"mcpServers":{"notion":{"command":"npx","args":["-y","@notionhq/notion-mcp-server"],"env":{"NOTION_TOKEN":"ntn_****"}}}}\n```',
      'pyproject.toml': '[project]\nname = "zotero-mcp"\n[project.scripts]\nzotero-mcp = "zotero_mcp:main"\n',
    };
    const out = await deriveMcpFromRepo({ repo: 'someone/zotero-mcp', read: (p) => files[p], paths: Object.keys(files), readme: files['README.md'], pypiMatches: async () => true });
    expect(out[0]).toMatchObject({ from: 'pyproject.toml', confidence: 'high' });
    expect(out[0].spec.config).toEqual({ command: 'uvx', args: ['zotero-mcp'] });
    const fromReadme = out.find((d) => d.from.includes('README'))!;
    expect(fromReadme.spec.config.env).toEqual({ NOTION_TOKEN: '{{NOTION_TOKEN}}' });
    expect(fromReadme.inputs[0]).toMatchObject({ name: 'NOTION_TOKEN', required: true, secret: true });
    expect(pyprojectScripts('[project]\nname = "serena-agent"\n[project.scripts]\nserena = "serena.cli:top"\n')).toEqual({ name: 'serena-agent', scripts: ['serena'] });
  });
});
