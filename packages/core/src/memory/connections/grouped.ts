/**
 * Grouped notes for markdown memory stores (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.9).
 *
 * The per-fact layout writes one Basic Memory note per new memory and never
 * touches it again: an update or a delete never reaches the store, a
 * reworded fact makes a second note, and a 1,000 item import fires 1,000
 * writes at once. The grouped layout keeps a few notes instead, each rebuilt
 * from the local rows whenever one of its memories changes:
 *
 *   conclave/profile.md              profile memories
 *   conclave/projects/<project>.md   project facts, decisions, gotchas
 *   conclave/hosts/<host>.md         facts about one machine (madx, pve...)
 *   conclave/paths.md                where things live
 *   conclave/procedures.md           how the owner does things
 *   conclave/notes.md                other global facts
 *   conclave/sessions/<YYYY-MM>.md   a monthly digest of episodes
 *
 * Changes are coalesced per note and written by a queue of two, so an
 * import makes one write per touched note, not one per memory. A kv map
 * remembers which note each memory is in, so a move or a delete rewrites
 * the note it left.
 */
import { basename } from 'node:path';
import type { MemoryEntry } from '../../types';
import type { EventBus } from '../../util/bus';
import type { KvRepo } from '../../storage/repos';
import { logger } from '../../util/log';
import { factNote, type ExternalNote } from '../external';
import { IMPORTED_TAG, isActive } from '../store';

const log = logger('memory.grouped');

export type NoteLayout = 'grouped' | 'per-fact';

const MAP_KEY = 'memory.grouped.map';
/** Most observations one note lists; the newest win. */
const MAX_LINES = 400;

/** A note name for a project or host; the daily digest links to notes by it. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}

function tagValue(e: Pick<MemoryEntry, 'tags'>, prefix: string): string | undefined {
  const t = e.tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : undefined;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The grouped note a memory belongs in, or undefined for rows that are never written out. */
export function noteKeyOf(e: MemoryEntry): string | undefined {
  if (e.tags.includes(IMPORTED_TAG) || !isActive(e) || e.scope === 'agent') return undefined;
  if (e.kind === 'episode') return `sessions/${new Date(e.meta?.observedAt ?? e.createdAt).toISOString().slice(0, 7)}`;
  if (e.kind === 'profile') return 'profile';
  if (e.kind === 'procedure') return 'procedures';
  const learned = e.meta?.learnedKind ?? tagValue(e, 'kind:');
  if (learned === 'path') return 'paths';
  const host = tagValue(e, 'host:');
  if (host) return `hosts/${slug(host)}`;
  const project = e.scope === 'project' && e.scopeKey ? basename(e.scopeKey.replace(/\/+$/, '')) : tagValue(e, 'project:');
  if (project) return `projects/${slug(project)}`;
  return 'notes';
}

const HEADINGS: Record<string, (name: string) => { title: string; intro: string }> = {
  profile: () => ({ title: 'Profile', intro: 'Who the owner is and how they like to work.' }),
  procedures: () => ({ title: 'Procedures', intro: 'How the owner does recurring tasks.' }),
  paths: () => ({ title: 'Paths', intro: 'Where things live on the owner’s machines.'.replace('’', "'") }),
  notes: () => ({ title: 'Notes', intro: 'Other facts Conclave keeps.' }),
  projects: (n) => ({ title: n, intro: `Facts and decisions about the ${n} project.` }),
  hosts: (n) => ({ title: n, intro: `Facts about the machine ${n}.` }),
  sessions: (n) => ({ title: n, intro: `What happened in past sessions in ${n}.` }),
};

/** Folder and title of a note key (Basic Memory makes the permalink from them). */
export function notePlace(key: string): { folder: string; title: string } {
  const i = key.indexOf('/');
  return i < 0 ? { folder: 'conclave', title: key } : { folder: `conclave/${key.slice(0, i)}`, title: key.slice(i + 1) };
}

/** The markdown of one grouped note: "- [kind] content (date, source)" lines and relations. */
export function renderGroupedNote(key: string, entries: MemoryEntry[]): ExternalNote {
  const { folder, title } = notePlace(key);
  const group = key.split('/')[0];
  const head = (HEADINGS[group] ?? HEADINGS.notes)(title);
  const sorted = [...entries].sort((a, b) => (b.meta?.observedAt ?? b.updatedAt) - (a.meta?.observedAt ?? a.updatedAt)).slice(0, MAX_LINES);
  const lines = sorted.map((e) => {
    const kind = e.meta?.learnedKind ?? (e.kind === 'episode' ? 'session' : e.kind);
    const when = day(e.meta?.observedAt ?? e.createdAt);
    const source = e.meta?.source ?? (e.sourceSessionId ? 'conclave' : 'saved');
    const seen = (e.meta?.seenCount ?? 1) > 1 ? `, seen ${e.meta!.seenCount} times` : '';
    const text = e.content.replace(/\s+/g, ' ').trim();
    return `- [${kind}] ${text} (${when}, ${source}${seen})`;
  });
  const related = new Set<string>();
  for (const e of sorted) {
    for (const t of e.tags) {
      const m = /^(host|project):(.+)$/.exec(t);
      if (m && `${m[1]}s/${slug(m[2])}` !== key) related.add(m[2]);
    }
  }
  const relations = [...related].sort().map((r) => `- relates_to [[${r}]]`);
  const body = [
    `# ${head.title}`,
    '',
    head.intro,
    'Conclave rebuilds this note from its memory. Edit the memories in Conclave, not here.',
    '',
    '## Observations',
    '',
    ...(lines.length ? lines : ['- [note] Nothing here yet.']),
    ...(relations.length ? ['', '## Relations', '', ...relations] : []),
  ].join('\n');
  return {
    title,
    content: body,
    folder,
    tags: ['conclave', group],
    kind: 'grouped',
    text: sorted.map((e) => e.content).join('\n'),
    grouped: true,
  };
}

/** Where a per-fact note Conclave wrote for a memory lives (the old layout), for clean up after grouping. */
export function perFactPermalink(e: MemoryEntry): string | undefined {
  if (e.tags.includes(IMPORTED_TAG) || (e.kind !== 'fact' && e.kind !== 'procedure')) return undefined;
  const note = factNote({ content: e.content, kind: e.kind, tags: e.tags, project: e.scope === 'project' ? e.scopeKey : undefined });
  return `${note.folder}/${note.title}`;
}

export interface GroupedTarget {
  /** Connections that take grouped notes. */
  groupedTargets(): string[];
  /** Write a grouped note to every grouped connection. */
  writeGrouped(note: ExternalNote): Promise<void>;
}

export interface GroupedNoteWriterOptions {
  rows: () => MemoryEntry[];
  get: (id: string) => MemoryEntry | undefined;
  target: GroupedTarget;
  kv: KvRepo;
  bus?: EventBus;
  concurrency?: number;
  /** Changes inside this window go into one write per note. */
  debounceMs?: number;
  /** Whose memory the notes are (docs/design/ACCOUNTS.md): another account's changes are not this writer's. Default: the owner's. */
  accountId?: string;
}

export class GroupedNoteWriter {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private map: Record<string, string> | undefined;
  private off?: () => void;
  /** Notes written since start, for tests and the connections page. */
  writes = 0;
  failures = 0;

  constructor(private opts: GroupedNoteWriterOptions) {}

  /** The id map's key: the owner keeps the old one, a member has their own. */
  private get mapKey(): string {
    const acct = this.opts.accountId ?? 'owner';
    return acct === 'owner' ? MAP_KEY : `acct:${acct}:${MAP_KEY}`;
  }

  start(): void {
    if (this.off || !this.opts.bus) return;
    const mine = (acct: string | undefined) => (acct ?? 'owner') === (this.opts.accountId ?? 'owner');
    this.off = this.opts.bus.on((e) => {
      if (e.type === 'memory.updated' && mine(e.entry.accountId)) this.touch(e.entry);
      else if (e.type === 'memory.deleted' && mine(e.accountId)) this.forget(e.id);
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    if (this.timer) clearTimeout(this.timer);
  }

  private idMap(): Record<string, string> {
    return (this.map ??= this.opts.kv.get<Record<string, string>>(this.mapKey, {}));
  }

  private active(): boolean {
    return this.opts.target.groupedTargets().length > 0;
  }

  /** A memory changed: its old note and its new one are rebuilt. */
  touch(entry: MemoryEntry): void {
    if (!this.active()) return;
    const map = this.idMap();
    const next = noteKeyOf(entry);
    const prev = map[entry.id];
    if (prev) this.pending.add(prev);
    if (next) {
      this.pending.add(next);
      map[entry.id] = next;
    } else delete map[entry.id];
    this.kick();
  }

  forget(id: string): void {
    if (!this.active()) return;
    const map = this.idMap();
    const prev = map[id];
    if (!prev) return;
    delete map[id];
    this.pending.add(prev);
    this.kick();
  }

  /** Every grouped note, from all local rows (the "Group notes" action). Returns the notes written. */
  async rebuildAll(): Promise<number> {
    const map: Record<string, string> = {};
    const keys = new Set<string>();
    for (const e of this.opts.rows()) {
      const k = noteKeyOf(e);
      if (!k) continue;
      map[e.id] = k;
      keys.add(k);
    }
    this.map = map;
    for (const k of keys) this.pending.add(k);
    const before = this.writes;
    await this.flush();
    return this.writes - before;
  }

  private kick(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.opts.debounceMs ?? 500);
  }

  /** Write everything pending now and wait. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.running) await this.running;
    if (this.pending.size) await this.drain();
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (this.pending.size) {
          const keys = [...this.pending];
          this.pending.clear();
          const byKey = new Map<string, MemoryEntry[]>(keys.map((k) => [k, []]));
          // one pass over the local rows for every note in this round
          for (const e of this.opts.rows()) {
            const k = noteKeyOf(e);
            if (k && byKey.has(k)) byKey.get(k)!.push(e);
          }
          this.opts.kv.set(this.mapKey, this.idMap());
          let i = 0;
          const worker = async () => {
            while (i < keys.length) {
              const key = keys[i++];
              try {
                await this.opts.target.writeGrouped(renderGroupedNote(key, byKey.get(key) ?? []));
                this.writes++;
              } catch (err) {
                this.failures++;
                log.warn(`grouped note ${key} was not written: ${(err as Error).message}`);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency ?? 2) }, worker));
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
