/**
 * Reading a fetched tree before anything is installed: the hooks and MCP
 * servers a plugin brings, the scripts, the files with their sizes, and the
 * warnings the preview shows (docs/design/ECOSYSTEM.md 1.6).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HooksConfig, McpServerConfig } from '../config/schema';
import { parseJsonc } from '../config';
import type { PluginManifest } from '../extensions/types';
import type { InstallSpec } from './recommended';
import type { PreviewFile, PreviewHook, PreviewWarning } from './types';
import { walkFiles } from './git';
import { hooksField } from '../extensions/loader';
import { parseFrontmatter } from '../util/frontmatter';

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return parseJsonc<T>(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The plugin manifest in a folder: Claude's location, the root file, then Codex's. */
export function readPluginManifest(dir: string, fallback: string): PluginManifest {
  for (const f of ['.claude-plugin/plugin.json', 'plugin.json', '.codex-plugin/plugin.json']) {
    const m = readJsonFile<PluginManifest>(join(dir, f));
    if (m) return { ...m, name: m.name || fallback };
  }
  return { name: fallback };
}

export function fileRole(rel: string): PreviewFile['role'] {
  if (/(^|\/)SKILL\.md$/.test(rel)) return 'skill';
  if (/(^|\/)\.mcp\.json$/.test(rel)) return 'mcp';
  if (/(^|\/)hooks\//.test(rel) || /(^|\/)hooks\.json$/.test(rel)) return 'hook';
  if (/(^|\/)(scripts|bin)\//.test(rel) || /\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1)$/.test(rel)) return 'script';
  if (/(^|\/)(plugin|marketplace|package)\.json$/.test(rel) || /(^|\/)pyproject\.toml$/.test(rel)) return 'manifest';
  if (/(^|\/)agents\/[^/]+\.md$/.test(rel)) return 'agent';
  if (/(^|\/)commands\/.+\.md$/.test(rel)) return 'command';
  return 'other';
}

/** Files under `dir` as preview rows at `dest` (a path under ~/.conclave shown to the owner). */
export function listFiles(dir: string, dest: string, root = dir): PreviewFile[] {
  const out: PreviewFile[] = [];
  for (const rel of walkFiles(dir, root)) {
    let st;
    try {
      st = statSync(join(dir, rel));
    } catch {
      continue;
    }
    out.push({ path: `${dest}/${rel}`, bytes: st.size, role: fileRole(rel), ...(st.mode & 0o111 ? { executable: true } : {}) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Guess the program a hook command runs: node, python3, bash, a binary name. */
export function interpreterOf(command: string): string {
  const known = /(?:^|[\s;&|(])(?:\S*\/)?(node|python3|python|bash|sh|zsh|bun|deno|uvx|uv|npx|pnpm|ruby|perl|jq|pwsh)(?=\s|$)/.exec(command.replace(/command -v \S+[^;|&]*(\|\||;)/g, ' '));
  if (known) return known[1] === 'python' ? 'python3' : known[1];
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() || 'bash';
}

const NETWORK = /\bcurl\b|\bwget\b|\bfetch\(|https?:\/\/|\bnc\s|\bInvoke-WebRequest\b/;

function hookFiles(dir: string, manifest: PluginManifest): Array<{ hooks: HooksConfig; file: string; extra: string[] }> {
  const out: Array<{ hooks: HooksConfig; file: string; extra: string[] }> = [];
  const seen = new Set<string>();
  const fromFile = (rel: string) => {
    const clean = rel.replace(/^\.\//, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    const data = readJsonFile<Record<string, unknown>>(join(dir, clean));
    if (!data) return;
    const extra = Object.keys(data).filter((k) => k !== 'hooks' && k !== 'description' && k !== '$schema');
    if (data.hooks && typeof data.hooks === 'object') out.push({ hooks: data.hooks as HooksConfig, file: clean, extra });
    else if (extra.length) out.push({ hooks: {}, file: clean, extra });
  };
  if (existsSync(join(dir, 'hooks', 'hooks.json'))) fromFile('hooks/hooks.json');
  const list = manifest.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
  for (const h of list as unknown[]) {
    if (typeof h === 'string') fromFile(h);
    else if (h && typeof h === 'object') {
      const o = h as Record<string, unknown>;
      out.push({ hooks: (o.hooks && typeof o.hooks === 'object' ? o.hooks : o) as HooksConfig, file: 'plugin.json', extra: [] });
    }
  }
  return out;
}

/** Every hook handler a plugin folder registers, with its full command. */
/**
 * Hooks in agent profiles' frontmatter. A profile runs its own `hooks:`
 * whenever the agent runs (extensions/agent-hooks.ts), so an added agent
 * file can run commands on the hub: the preview lists them. `path` is one
 * .md file or a folder of them; `label` names it in the preview.
 */
export function agentFileHooks(path: string, label: string): PreviewHook[] {
  const out: PreviewHook[] = [];
  let files: string[];
  try {
    files = statSync(path).isDirectory() ? walkFiles(path).filter((f) => f.endsWith('.md')).slice(0, 200).map((f) => join(path, f)) : path.endsWith('.md') ? [path] : [];
  } catch {
    return out;
  }
  for (const file of files) {
    let hooks: HooksConfig | undefined;
    try {
      hooks = hooksField(parseFrontmatter(readFileSync(file, 'utf8').slice(0, 64_000)).data.hooks);
    } catch {
      continue;
    }
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      for (const g of groups ?? []) {
        for (const h of g.hooks as unknown as Array<Record<string, unknown>>) {
          const command = typeof h.command === 'string' ? h.command : undefined;
          const prompt = h.type === 'prompt';
          out.push({
            event: event as PreviewHook['event'],
            matcher: g.matcher || undefined,
            interpreter: prompt ? 'prompt' : command ? interpreterOf(command) : String(h.type ?? 'command'),
            timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
            command: command ?? (typeof h.prompt === 'string' ? h.prompt : undefined),
            plugin: file === path ? label : `${label}/${file.slice(path.length + 1)}`,
            network: !!command && NETWORK.test(command),
          });
        }
      }
    }
  }
  return out;
}

export function pluginHooks(dir: string, manifest: PluginManifest, plugin: string): { hooks: PreviewHook[]; ignored: string[] } {
  const hooks: PreviewHook[] = [];
  const ignored: string[] = [];
  for (const f of hookFiles(dir, manifest)) {
    for (const k of f.extra) ignored.push(`"${k}" in ${f.file}`);
    for (const [event, groups] of Object.entries(f.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as unknown as Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>) {
        for (const h of g?.hooks ?? []) {
          const command = typeof h.command === 'string' ? h.command : undefined;
          const prompt = h.type === 'prompt';
          if (h.asyncRewake) ignored.push(`asyncRewake on a ${event} hook`);
          hooks.push({
            event: event as PreviewHook['event'],
            matcher: g.matcher || undefined,
            interpreter: prompt ? 'prompt' : command ? interpreterOf(command) : String(h.type ?? 'command'),
            timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
            command: command ?? (typeof h.prompt === 'string' ? h.prompt : undefined),
            plugin,
            network: !!command && NETWORK.test(command),
          });
        }
      }
    }
  }
  return { hooks, ignored };
}

/** MCP servers a plugin folder adds (.mcp.json and the manifest). */
export function pluginMcp(dir: string, manifest: PluginManifest): Array<{ name: string; config: McpServerConfig }> {
  const out: Array<{ name: string; config: McpServerConfig }> = [];
  const add = (data: Record<string, unknown> | undefined) => {
    if (!data) return;
    const map = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data) as Record<string, unknown>;
    for (const [name, cfg] of Object.entries(map)) if (cfg && typeof cfg === 'object') out.push({ name, config: cfg as McpServerConfig });
  };
  add(readJsonFile(join(dir, '.mcp.json')));
  const m = manifest.mcpServers;
  for (const x of m === undefined ? [] : Array.isArray(m) ? m : [m]) {
    if (typeof x === 'string') {
      if (x.replace(/^\.\//, '') !== '.mcp.json') add(readJsonFile(join(dir, x)));
    } else if (x && typeof x === 'object') add(x as Record<string, unknown>);
  }
  return out;
}

/**
 * The !`cmd` lines of the skill and command files at `path` (a folder or one
 * file) that land at `shownAs`. Typing the skill or command as /name runs
 * them on the session's device without asking (extensions/commands.ts).
 */
export function inlineCommands(path: string, shownAs: string, root: string): string[] {
  let rels: string[];
  try {
    rels = statSync(path).isDirectory() ? walkFiles(path, root) : [''];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of rels) {
    const role = fileRole(rel ? `${shownAs}/${rel}` : shownAs);
    if (role !== 'skill' && role !== 'command') continue;
    try {
      for (const m of readFileSync(rel ? join(path, rel) : path, 'utf8').slice(0, 200_000).matchAll(/!`([^`]+)`/g)) out.push(m[1].trim());
    } catch {
      /* gone */
    }
  }
  return out;
}

/** The preview line for inlineCommands. */
export function inlineCommandWarnings(cmds: string[]): PreviewWarning[] {
  if (!cmds.length) return [];
  const shown = cmds.slice(0, 3).map((c) => c.slice(0, 80)).join('; ');
  return [{ level: 'warn', text: `Its skills or commands run ${cmds.length === 1 ? 'a shell command' : `${cmds.length} shell commands`} on the session's device, without asking, when you type their /name: ${shown}${cmds.length > 3 ? ` and ${cmds.length - 3} more` : ''}.` }];
}

/** Executable files and package.json scripts in a folder. */
export function scriptsIn(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const rel of walkFiles(dir, root)) {
    try {
      if (statSync(join(dir, rel)).mode & 0o111) out.push(rel);
    } catch {
      /* gone */
    }
  }
  const pkg = readJsonFile<{ scripts?: Record<string, string> }>(join(dir, 'package.json'));
  for (const [k, v] of Object.entries(pkg?.scripts ?? {})) out.push(`package.json script ${k}: ${v}`);
  return out;
}

const OSI = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only',
  'GPL-3.0-or-later', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-3.0', 'LGPL-3.0-only', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Unlicense',
  '0BSD', 'EPL-2.0', 'Zlib', 'BSL-1.0', 'Artistic-2.0', 'MIT-0', 'UPL-1.0', 'EUPL-1.2', 'CC0-1.0',
]);

/** true when every part of the license is OSI approved, false when one is not, undefined when unknown. */
export function licenseIsOsi(license?: string): boolean | undefined {
  if (!license) return undefined;
  const parts = license.split(/\s+(?:and|AND|or|OR)\s+|\s*[,/]\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.some((p) => /elastic|busl|bsl-1\.1|sspl|cc-by|commons clause|source.available|polyform|other|proprietary/i.test(p))) return false;
  return parts.every((p) => OSI.has(p)) ? true : undefined;
}

/** Text checks over hooks and scripts: network calls, curl | sh, installs at session start, hooks on every tool call. */
export function hookWarnings(hooks: PreviewHook[], scripts: Array<{ path: string; text: string }>): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const push = (w: PreviewWarning) => {
    if (!out.some((x) => x.text === w.text)) out.push(w);
  };
  for (const h of hooks) {
    const cmd = h.command ?? '';
    const where = `${h.event}${h.matcher ? ` (${h.matcher})` : ''}`;
    if (h.network) push({ level: 'warn', text: `A ${where} hook makes network calls: ${cmd.slice(0, 120)}` });
    if (/(curl|wget)[^|\n]*\|\s*(ba|z)?sh\b/.test(cmd)) push({ level: 'risk', text: `A ${where} hook pipes a download into a shell.` });
    if (h.event === 'SessionStart' && /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\buv\s+(pip|tool)\s+install\b/.test(cmd))
      push({ level: 'risk', text: 'A SessionStart hook installs packages every time a session starts.' });
    if ((h.event === 'PreToolUse' || h.event === 'PostToolUse') && (!h.matcher || h.matcher === '*' || h.matcher === '.*'))
      push({ level: 'info', text: `A ${h.event} hook runs on every tool call (${h.interpreter}).` });
  }
  const piped = scripts.filter((f) => /(curl|wget)[^|\n]*\|\s*(ba|z)?sh\b/.test(f.text)).map((f) => f.path);
  if (piped.length) push({ level: 'warn', text: `${piped.slice(0, 3).join(', ')}${piped.length > 3 ? ` and ${piped.length - 3} more` : ''} ${piped.length === 1 ? 'pipes' : 'pipe'} a download into a shell. Conclave never runs them; check before you run them yourself.` });
  return out;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);

/** What a stdio command can do beyond starting one program: a shell line, a download piped to a shell, docker flags that reach the host. */
export function commandWarnings(cfg: McpServerConfig): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  if (!cfg.command) return out;
  const bin = cfg.command.split('/').pop()!.toLowerCase();
  const args = cfg.args ?? [];
  const line = [cfg.command, ...args].join(' ');
  if (SHELLS.has(bin)) out.push({ level: 'risk', text: `Starts ${bin}, which runs whatever the arguments say: ${line.slice(0, 160)}` });
  if (/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/.test(line)) out.push({ level: 'risk', text: 'Pipes a download into a shell every time the server starts.' });
  if (bin === 'docker' || bin === 'podman') {
    const wide: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--privileged') wide.push(a);
      else if (a === '-v' || a === '--volume' || a === '--mount') wide.push(`${a} ${args[i + 1] ?? ''}`.trim());
      else if (/^--(volume|mount)=/.test(a)) wide.push(a);
      else if ((a === '--network' || a === '--net' || a === '--pid' || a === '--ipc') && args[i + 1] === 'host') wide.push(`${a} host`);
      else if (/^--(network|net|pid|ipc)=host$/.test(a)) wide.push(a);
      else if (a === '--cap-add' || a === '--device') wide.push(`${a} ${args[i + 1] ?? ''}`.trim());
      else if (/^--(cap-add|device)=/.test(a)) wide.push(a);
    }
    if (wide.length) out.push({ level: 'warn', text: `The container gets more of the hub than the server needs to talk over stdio: ${wide.slice(0, 4).join(', ')}.` });
  }
  return out;
}

/** Fields Conclave reads past: plugin userConfig, LSP servers, output styles. */
export function ignoredManifestFields(manifest: PluginManifest): string[] {
  const m = manifest as unknown as Record<string, unknown>;
  const out: string[] = [];
  if (m.userConfig) out.push('userConfig (settings the plugin asks for)');
  if (m.lspServers) out.push('lspServers');
  if (m.outputStyles) out.push('outputStyles');
  if (m.statusLine || m.statusline) out.push('the status line');
  return out;
}

/** Placeholders ("{{NAME}}") an install spec uses. */
export function specPlaceholders(spec: InstallSpec | InstallSpec[]): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(spec).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) out.add(m[1]);
  return [...out];
}

/** Secret inputs used anywhere but env and headers (McpManager would send them as typed in older hubs, and they show in process lists). */
export function secretsOutsideEnv(spec: InstallSpec, secretNames: string[]): string[] {
  if (spec.type !== 'mcp') return [];
  const outside = JSON.stringify([spec.config.command ?? '', spec.config.args ?? [], spec.config.url ?? '', spec.config.cwd ?? '']);
  return secretNames.filter((n) => outside.includes(`{{${n}}}`));
}
