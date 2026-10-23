/**
 * Render memory as markdown for backup and git. Two layouts:
 *
 * - single: one file, conclave-memory.md, grouped by kind and scope.
 * - folder: Basic Memory style notes (frontmatter, "- [kind] text #tag"
 *   observations, [[relations]]) under one root folder:
 *     <root>/profile.md
 *     <root>/facts/global.md, facts/project-<name>.md, facts/agent-<name>.md
 *     <root>/sessions/<date> <topic> (<id>).md   one per episode
 *
 * Order is stable (oldest first, then id) so a git diff shows only real
 * changes. Secrets are redacted again on the way out. Notes imported from
 * memory connections are left out unless asked for, since they live elsewhere.
 */
import type { MemoryEntry, MemoryScope } from '../types';
import { episodeNote, projectName } from './external';
import { redactSecrets } from './secrets';
import { isImported } from './store';

export interface MarkdownFile {
  /** Relative path, forward slashes. */
  path: string;
  content: string;
}

export interface MarkdownExport {
  layout: 'single' | 'folder';
  files: MarkdownFile[];
  /** Memories included. */
  count: number;
  generatedAt: string;
}

export interface MarkdownExportOptions {
  layout?: 'single' | 'folder';
  /** Root folder for the folder layout. Default "conclave-memory". */
  root?: string;
  includeImported?: boolean;
  /** Clock override for tests. */
  now?: Date;
}

function oneLine(s: string): string {
  return redactSecrets(s).replace(/\s*\n+\s*/g, ' ').trim();
}

function tagText(tags: string[]): string {
  return tags
    .filter((t) => /^[\w.-]+$/.test(t) && !t.startsWith('source:') && t !== 'imported')
    .map((t) => `#${t}`)
    .join(' ');
}

function observation(e: MemoryEntry): string {
  const tags = tagText(e.tags);
  return `- [${e.kind}] ${oneLine(e.content)}${tags ? ' ' + tags : ''}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function frontmatter(title: string, permalink: string, tags: string[]): string {
  return ['---', `title: ${JSON.stringify(title)}`, 'type: note', `permalink: ${permalink}`, 'tags:', ...tags.map((t) => `- ${t}`), '---', ''].join('\n');
}

interface Group {
  scope: MemoryScope;
  key?: string;
  label: string;
  file: string;
  entries: MemoryEntry[];
}

function groupKey(e: MemoryEntry): string {
  return `${e.scope}|${e.scopeKey ?? ''}`;
}

function groupsOf(entries: MemoryEntry[]): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const k = groupKey(e);
    let g = map.get(k);
    if (!g) {
      const name = e.scope === 'project' ? (projectName(e.scopeKey) ?? 'project') : (e.scopeKey ?? '');
      g = {
        scope: e.scope,
        key: e.scopeKey,
        label: e.scope === 'global' ? 'Global' : e.scope === 'project' ? `Project: ${name} (${e.scopeKey})` : `Agent: ${e.scopeKey}`,
        file: e.scope === 'global' ? 'global' : `${e.scope}-${slug(name)}`,
        entries: [],
      };
      map.set(k, g);
    }
    g.entries.push(e);
  }
  // global first, then by label
  return [...map.values()].sort((a, b) => (a.scope === 'global' ? -1 : b.scope === 'global' ? 1 : a.label.localeCompare(b.label)));
}

function sortStable(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function renderMemoryMarkdown(all: MemoryEntry[], opts: MarkdownExportOptions = {}): MarkdownExport {
  const layout = opts.layout ?? 'single';
  const now = opts.now ?? new Date();
  const entries = sortStable(all.filter((e) => opts.includeImported || !isImported(e)));
  const profile = entries.filter((e) => e.kind === 'profile');
  const facts = entries.filter((e) => e.kind === 'fact' || e.kind === 'procedure');
  const episodes = entries.filter((e) => e.kind === 'episode');
  const generatedAt = now.toISOString();

  if (layout === 'single') {
    const lines: string[] = [frontmatter('Conclave memory', 'conclave-memory', ['conclave', 'memory']), '# Conclave memory', '', `Exported ${day(now.getTime())}. ${entries.length} memories.`, ''];
    const section = (title: string, list: MemoryEntry[]) => {
      if (!list.length) return;
      lines.push(`## ${title}`, '');
      for (const g of groupsOf(list)) lines.push(`### ${g.label}`, '', ...g.entries.map(observation), '');
    };
    section('Profile', profile);
    section('Facts and procedures', facts);
    if (episodes.length) {
      lines.push('## Sessions', '');
      for (const e of episodes) {
        const proj = e.scope === 'project' ? projectName(e.scopeKey) : undefined;
        lines.push(`### ${day(e.createdAt)}${proj ? ` · ${proj}` : ''}${e.sourceSessionId ? ` · ${e.sourceSessionId}` : ''}`, '', redactSecrets(e.content.trim()), '');
      }
    }
    return { layout, files: [{ path: 'conclave-memory.md', content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' }], count: entries.length, generatedAt };
  }

  const root = (opts.root ?? 'conclave-memory').replace(/^\/+|\/+$/g, '') || 'conclave-memory';
  const files: MarkdownFile[] = [];
  if (profile.length) {
    const body = [frontmatter('Profile', `${root}/profile`, ['conclave', 'profile']), '# Profile', ''];
    for (const g of groupsOf(profile)) body.push(`## ${g.label}`, '', ...g.entries.map(observation), '');
    files.push({ path: `${root}/profile.md`, content: body.join('\n').trimEnd() + '\n' });
  }
  const usedFiles = new Set<string>();
  for (const g of groupsOf(facts)) {
    // two projects can share a folder name (/a/web and /b/web): the second file must not overwrite the first
    let file = g.file;
    for (let n = 2; usedFiles.has(file); n++) file = `${g.file}-${n}`;
    usedFiles.add(file);
    const title = g.scope === 'global' ? 'Facts' : `Facts: ${g.label.replace(/^\w+: /, '')}`;
    const body = [frontmatter(title, `${root}/facts/${file}`, ['conclave', 'facts']), `# ${title}`, '', '## Observations', '', ...g.entries.map(observation)];
    if (g.scope === 'project' && g.key) body.push('', '## Relations', '', `- relates_to [[${projectName(g.key)}]]`);
    if (g.scope === 'agent' && g.key) body.push('', '## Relations', '', `- used_by [[${g.key}]]`);
    files.push({ path: `${root}/facts/${file}.md`, content: body.join('\n').trimEnd() + '\n' });
  }
  const used = new Set<string>();
  for (const e of episodes) {
    const note = episodeNote({
      sessionId: e.sourceSessionId ?? e.id,
      summary: redactSecrets(e.content),
      project: e.scope === 'project' ? e.scopeKey : undefined,
      agent: e.tags.find((t) => t !== 'episode'),
      date: new Date(e.createdAt),
    });
    let name = note.title.replace(/[\\/:*?"<>|]/g, ' ').trim();
    while (used.has(name)) name += ' x';
    used.add(name);
    const permalink = `${root}/sessions/${slug(name)}`;
    files.push({ path: `${root}/sessions/${name}.md`, content: frontmatter(note.title, permalink, note.tags ?? ['conclave', 'session']) + note.content.trimEnd() + '\n' });
  }
  return { layout, files, count: entries.length, generatedAt };
}
