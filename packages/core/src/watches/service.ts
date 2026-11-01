/**
 * Watches (DESIGN.md 34): the items each watch keeps, the runs that change
 * them, the notices, and the photos the hub keeps for the cards.
 *
 * A watch is a routine with Routine.watch. Its run is an agent session like
 * any routine's, with three differences the hub makes in run():
 * - the session is untrusted and marked as the watch's run, its browser is
 *   on the watch's profile and only reads (rules.ts);
 * - the prompt gets the hub's run rules, and a data block with the filters
 *   and every item listed after the last run, so the run can check them;
 * - when the run ends, what it reported with WatchReport is compared with
 *   what the hub kept (diff.ts), saved, and the owner hears about it when
 *   something changed (or every run, with notify: daily).
 *
 * The tables are created here with IF NOT EXISTS instead of in the shared
 * migration list, so another branch adding a migration cannot collide. A
 * routine's rows and photos go when the routine is deleted.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { EventBus } from '../util/bus';
import type { Message, Notice, Routine, RoutineRun } from '../types';
import type { RoutineInput } from '../scheduler/types';
import { logger } from '../util/log';
import { currentAccount, isMember } from '../people/context';
import { checkPublicUrl } from '../people/net';
import { changedCount, countWords, diffRun, sortItems } from './diff';
import { RUN_RULES, isWatch, runContext, watchAllow, watchDeny } from './rules';
import { MAX_REPORTED, RUNS_KEPT, cleanItem, cleanWatchSpec, httpUrl } from './spec';
import type { ReportedItem, WatchCounts, WatchDetailDto, WatchItem, WatchItemsCard, WatchNotice, WatchRunSummary, WatchSpec, WatchSummaryDto } from './types';

const log = logger('watches');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watch_items (
  routine_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  present INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (routine_id, item_id)
);
CREATE TABLE IF NOT EXISTS watch_runs (
  routine_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (routine_id, run_id)
);
CREATE INDEX IF NOT EXISTS watch_runs_at ON watch_runs(routine_id, at DESC);
`;

/** Photos kept per watch, in bytes. Past it, photos are passed through without a copy. */
export const IMAGE_DIR_CAP = 40 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Items a notice lists and the in-app card shows. */
const NOTICE_ITEMS = 6;
/** Chats whose last items are kept for a watch made from them. */
const DRAFTS_KEPT = 50;

export type RunResult = { sessionId: string; summary?: string; error?: string; denied?: RoutineRun['denied'] };
export type RunHooks = { started?: (sessionId: string) => void; context?: string; from?: string };

/** What a run needs from the browser (browser/manager.ts). */
export interface WatchBrowser {
  setProfile(sessionId: string, profile: string): string;
  setReadOnly(sessionId: string, on: boolean): void;
  closeSession(sessionId: string): Promise<void>;
  profileFor(sessionId: string): string;
  /** The profile the owner signed in to this host with (Settings > Browser), if any. */
  profileSignedInTo?(host: string): string | undefined;
}

/** WatchCreate's input, checked by create(). */
export interface WatchCreateInput {
  name: string;
  schedule: string;
  url: string;
  prompt: string;
  profile?: string;
  fields?: string[];
  filters?: unknown;
  notify?: 'change' | 'daily';
  currency?: string;
  cap?: number;
}

export interface WatchServiceOptions {
  db: Db;
  bus: EventBus;
  routines: { get(id: string): Routine | undefined; list(): Routine[]; create?(input: RoutineInput): Routine };
  /** The owner's timezone for new watches (the assistant's). */
  zone?: () => string | undefined;
  /** The hub's browser. Without it runs still run, on whatever browser the session gets. */
  browser?: () => WatchBrowser | undefined;
  /** Mark a run's session (untrusted, the watch, the run). */
  patchMeta?: (sessionId: string, meta: Record<string, unknown>) => void;
  /** A session's messages, to find the items a chat showed (WatchCreate after a restart). */
  messages?: (sessionId: string) => Message[];
  notify: (kind: 'routineDone' | 'errors', notice: Omit<Notice, 'id' | 'createdAt'>) => void;
  /** Where photos are kept, one folder per watch. */
  imageDir: string;
  now?: () => number;
  fetch?: typeof fetch;
}

interface Pending {
  routineId: string;
  runId: string;
  reports: ReportedItem[];
  problems: number;
}

type Row = Record<string, any>;

export class WatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class WatchService {
  private db: Db;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private drafts = new Map<string, { items: ReportedItem[]; source?: string; at: number }>();
  private off: Array<() => void> = [];

  constructor(private opts: WatchServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.db.exec(SCHEMA);
    this.off.push(
      opts.bus.on((e) => {
        if (e.type === 'routine.deleted') this.remove(e.routineId);
      }),
    );
    this.sweep();
  }

  stop(): void {
    for (const f of this.off.splice(0)) f();
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  items(routineId: string): WatchItem[] {
    const rows = this.db.query('SELECT data FROM watch_items WHERE routine_id = ?').all(routineId) as Row[];
    return sortItems(rows.map((r) => json<WatchItem | null>(r.data, null)).filter((i): i is WatchItem => !!i));
  }

  item(routineId: string, itemId: string): WatchItem | undefined {
    const r = this.db.query('SELECT data FROM watch_items WHERE routine_id = ? AND item_id = ?').get(routineId, itemId) as Row | null;
    return r ? (json<WatchItem | null>(r.data, null) ?? undefined) : undefined;
  }

  runs(routineId: string, limit = 30): WatchRunSummary[] {
    const rows = this.db.query('SELECT data FROM watch_runs WHERE routine_id = ? ORDER BY at DESC LIMIT ?').all(routineId, limit) as Row[];
    return rows.map((r) => json<WatchRunSummary | null>(r.data, null)).filter((x): x is WatchRunSummary => !!x);
  }

  summary(routine: Routine): WatchSummaryDto {
    const items = this.items(routine.id);
    const last = this.runs(routine.id, 1)[0];
    const listed = items.filter((i) => i.present);
    const cover = listed.find((i) => i.image);
    return {
      routineId: routine.id,
      count: listed.length,
      newCount: last?.counts.new ?? 0,
      ...(last ? { last } : {}),
      ...(cover ? { cover: { itemId: cover.id, title: cover.title } } : {}),
    };
  }

  /** Every watch with its counts, for the Routines page. The watches of one account (routines from before accounts are the owner's), or every one. */
  summaries(accountId?: string): WatchSummaryDto[] {
    return this.opts.routines
      .list()
      .filter(isWatch)
      .filter((r) => !accountId || (r.accountId ?? 'owner') === accountId)
      .map((r) => this.summary(r));
  }

  detail(routineId: string): WatchDetailDto {
    const r = this.opts.routines.get(routineId);
    if (!r || !isWatch(r)) throw new WatchError(404, 'No watch with that id.');
    return { ...this.summary(r), spec: r.watch, items: this.items(routineId), runs: this.runs(routineId) };
  }

  // -------------------------------------------------------------------------
  // WatchReport
  // -------------------------------------------------------------------------

  /**
   * Items a session reports. In a watch run they wait for the end of the run;
   * in a chat they are what a watch made from the chat starts with. The reply
   * tells the model what it still has to check.
   */
  report(session: { id: string; meta?: Record<string, unknown> }, raw: unknown[], source?: string): { text: string; card: WatchItemsCard; problems: string[] } {
    const problems: string[] = [];
    const items: ReportedItem[] = [];
    for (const v of raw.slice(0, MAX_REPORTED)) {
      const c = cleanItem(v);
      if (c.item) items.push(c.item);
      else if (c.problem && problems.length < 5) problems.push(c.problem);
    }
    if (raw.length > MAX_REPORTED) problems.push(`only the first ${MAX_REPORTED} items count`);
    const p = this.pending.get(session.id);
    const routineId = typeof session.meta?.watch === 'string' ? session.meta.watch : undefined;
    if (p && routineId === p.routineId) {
      const room = MAX_REPORTED - p.reports.length;
      if (room <= 0) return { text: `This run already reported ${MAX_REPORTED} items, the most one run may. End the run.`, card: this.card(items, source), problems };
      p.reports.push(...items.slice(0, room));
      const routine = this.opts.routines.get(p.routineId);
      const known = new Map(this.items(p.routineId).filter((i) => i.present).map((i) => [i.id, i]));
      const reported = new Set(p.reports.map((i) => i.id));
      const fresh = [...reported].filter((id) => !known.has(id)).length;
      const left = [...known.values()].filter((i) => !reported.has(i.id));
      const lines = [`Recorded ${items.length} ${items.length === 1 ? 'item' : 'items'} (${reported.size} this run, ${fresh} not seen before).`];
      if (left.length) {
        lines.push(`Not reported yet from the last run: ${left.length}. Open each link and report it, or it counts as gone:`);
        for (const i of left.slice(0, 40)) lines.push(`- ${i.id} | ${i.title}${i.url ? ` | ${i.url}` : ''}`);
        if (left.length > 40) lines.push(`- and ${left.length - 40} more`);
      } else lines.push('Every item from the last run is reported. End with one line on what changed.');
      if (problems.length) lines.push(`Not kept: ${problems.join('; ')}.`);
      const card = this.card(items, source, routine?.watch?.currency);
      return { text: lines.join('\n'), card: { ...card, routineId: p.routineId }, problems };
    }
    // a chat: show them, and keep them for a watch made from here
    if (items.length) {
      this.drafts.delete(session.id);
      this.drafts.set(session.id, { items, source, at: this.now() });
      while (this.drafts.size > DRAFTS_KEPT) this.drafts.delete(this.drafts.keys().next().value!);
    }
    const lines = [`The owner sees ${items.length} ${items.length === 1 ? 'item' : 'items'} as cards with photos, prices and links. Reply in a line or two; do not list them again.`];
    if (items.length) lines.push('To have the hub watch this search, offer "Watch this daily" and, on a yes, call WatchCreate; these items become its starting point.');
    if (problems.length) lines.push(`Not shown: ${problems.join('; ')}.`);
    return { text: lines.join('\n'), card: { ...this.card(items, source), offer: items.length > 0 }, problems };
  }

  private card(items: ReportedItem[], source?: string, currency?: string): WatchItemsCard {
    return {
      kind: 'items',
      ...(source ? { source } : {}),
      ...(currency ? { currency } : {}),
      items: items.slice(0, 60).map((i) => ({
        id: i.id,
        title: i.title,
        ...(i.price !== undefined ? { price: i.price } : {}),
        ...(i.priceText ? { priceText: i.priceText } : {}),
        ...(i.location ? { location: i.location } : {}),
        ...(i.url ? { url: i.url } : {}),
        ...(i.image ? { image: i.image } : {}),
        status: i.status ?? 'available',
        ...(i.fields ? { fields: i.fields } : {}),
      })),
    };
  }

  /** The items a chat last showed: kept in memory, else read back from the chat's last WatchReport call. */
  draft(sessionId: string): ReportedItem[] {
    const hit = this.drafts.get(sessionId);
    if (hit) return hit.items;
    const msgs = this.opts.messages?.(sessionId) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b.type !== 'tool_use' || b.name !== 'WatchReport') continue;
        const raw = (b.input as { items?: unknown })?.items;
        if (!Array.isArray(raw)) continue;
        return raw.slice(0, MAX_REPORTED).map((v) => cleanItem(v).item).filter((x): x is ReportedItem => !!x);
      }
    }
    return [];
  }

  /**
   * WatchCreate: a routine that is a watch. It runs on the session's agent,
   * on the hub, reading only, on the profile the chat browsed with (or the
   * one signed in to the site), and starts from the items the chat showed.
   */
  create(input: WatchCreateInput, from: { sessionId?: string; agent?: string }): { routine: Routine; seeded: number } {
    if (!this.opts.routines.create) throw new WatchError(501, 'This hub cannot make routines.');
    const b = this.opts.browser?.();
    const host = (() => {
      try {
        return new URL(String(input.url)).hostname;
      } catch {
        return '';
      }
    })();
    const used = from.sessionId && b ? b.profileFor(from.sessionId) : undefined;
    // a member's watch runs in their own browser, which has one profile: the owner's profiles are not theirs to name
    const member = isMember(currentAccount()) || !!used?.startsWith('@');
    const profile = member ? 'default' : input.profile?.trim() || (used && used !== 'default' ? used : undefined) || (host ? b?.profileSignedInTo?.(host) : undefined) || 'default';
    let spec: WatchSpec;
    try {
      spec = cleanWatchSpec({ url: input.url, profile, fields: input.fields, filters: input.filters, notify: input.notify, currency: input.currency, cap: input.cap });
    } catch (err) {
      throw new WatchError(400, (err as Error).message);
    }
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    if (!name || !prompt || !String(input.schedule ?? '').trim()) throw new WatchError(400, 'name, schedule, url and prompt are all required.');
    const zone = this.opts.zone?.();
    let routine: Routine;
    try {
      routine = this.opts.routines.create({
        name,
        schedule: String(input.schedule).trim(),
        prompt,
        ...(from.agent ? { agent: from.agent } : {}),
        ...(zone ? { timezone: zone } : {}),
        // failures say so like any routine's; what changed comes from the watch (finish)
        notify: 'on_error',
        sessionPolicy: 'new',
        onApproval: 'deny',
        timeoutMin: 20,
        allow: watchAllow(spec),
        deny: watchDeny(),
        watch: spec,
      });
    } catch (err) {
      throw new WatchError(400, (err as Error).message);
    }
    const seeded = from.sessionId ? this.seed(routine.id, this.draft(from.sessionId)) : 0;
    return { routine, seeded };
  }

  /** A new watch starts with the items its chat showed: the first run then reports what changed since. */
  seed(routineId: string, reports: ReportedItem[]): number {
    const r = this.opts.routines.get(routineId);
    if (!r || !isWatch(r) || !reports.length) return 0;
    const result = diffRun([], reports, r.watch, this.now());
    // seen in the chat: listed, not new
    const items = result.items.map((i) => ({ ...i, mark: 'still' as const }));
    this.saveItems(routineId, items, []);
    return items.length;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** The prompt a run gets: the routine's own, then the hub's run rules. */
  runPrompt(routine: Routine): string {
    return `${routine.prompt.trim()}\n\n${RUN_RULES}`;
  }

  /** The data block a run gets. */
  runContext(routine: Routine): string {
    return runContext(routine, routine.watch!, this.items(routine.id));
  }

  /**
   * Run a watch through the normal routine runner (`inner`), set up as a
   * watch run, and compare what it reported when it ends.
   */
  async run(routine: Routine, run: RoutineRun, hooks: RunHooks | undefined, inner: (r: Routine, hooks: RunHooks) => Promise<RunResult>): Promise<RunResult> {
    if (!isWatch(routine)) return inner(routine, hooks ?? {});
    let sid: string | undefined;
    const started = (id: string) => {
      sid = id;
      this.begin(routine, run, id);
      hooks?.started?.(id);
    };
    let res: RunResult;
    try {
      res = await inner({ ...routine, prompt: this.runPrompt(routine) }, { ...hooks, started, from: '@watch', context: this.runContext(routine) });
    } catch (err) {
      res = { sessionId: sid ?? '', error: (err as Error)?.message ?? String(err) };
    }
    return this.finish(routine, run, sid ?? res.sessionId, res);
  }

  /** Before the model works: the session is the watch's run, untrusted, on the watch's profile, reading only. */
  begin(routine: Routine, run: Pick<RoutineRun, 'id'>, sessionId: string): void {
    this.pending.set(sessionId, { routineId: routine.id, runId: run.id, reports: [], problems: 0 });
    this.opts.patchMeta?.(sessionId, { untrusted: true, watch: routine.id, watchRun: run.id });
    const b = this.opts.browser?.();
    if (b) {
      b.setProfile(sessionId, routine.watch?.profile || 'default');
      b.setReadOnly(sessionId, true);
    }
  }

  /** After the run: compare, save, tell the owner. A run that failed or reported nothing changes nothing. */
  async finish(routine: Routine, run: Pick<RoutineRun, 'id' | 'trigger'>, sessionId: string, res: RunResult): Promise<RunResult> {
    const p = sessionId ? this.pending.get(sessionId) : undefined;
    if (sessionId) this.pending.delete(sessionId);
    const b = this.opts.browser?.();
    if (b && sessionId) {
      await b.closeSession(sessionId).catch(() => undefined);
      b.setReadOnly(sessionId, false);
    }
    if (res.error) return res;
    // deleted while the run went: its rows and photos are gone, and this run must not bring them back
    const latest = this.opts.routines.get(routine.id);
    if (!latest) return res;
    const spec: WatchSpec | undefined = latest.watch ?? routine.watch;
    if (!spec) return res;
    if (!p?.reports.length) {
      const error = 'The run reported no items, so nothing was compared. The site may have changed, or the browser profile may need to sign in again (Settings, Browser).';
      if (latest.notify !== 'never') this.opts.notify('errors', { title: `Watch failed: ${latest.name}`, body: error, level: 'error', sessionId, link: `/routines/${routine.id}` });
      return { ...res, error };
    }
    const now = this.now();
    const result = diffRun(this.items(routine.id), p.reports, spec, now);
    const summary: WatchRunSummary = { runId: run.id, routineId: routine.id, ...result.summary };
    this.saveItems(routine.id, result.items, result.dropped);
    this.saveRun(summary);
    this.pruneImages(routine.id, result.items);
    log.info(`watch ${latest.name}: ${summary.words}, ${summary.total} listed`);
    const changed = changedCount(summary.counts) > 0;
    if (latest.notify !== 'never' && (changed || spec.notify === 'daily')) this.opts.notify('routineDone', this.notice(latest, spec, summary, result.items, sessionId));
    const words = changed ? summary.words : countWords(summary.counts, { still: true });
    return { ...res, summary: `${words}. ${summary.total} listed.` };
  }

  /** The notice: "3 new, 1 gone, 1 price drop", a line per item, and the card data for the apps. */
  notice(routine: Routine, spec: WatchSpec, s: WatchRunSummary, items: WatchItem[], sessionId?: string): Omit<Notice, 'id' | 'createdAt'> {
    const byId = new Map(items.map((i) => [i.id, i]));
    const order: Array<[keyof WatchRunSummary['changes'], string]> = [
      ['new', 'New'],
      ['priceDown', 'Price drop'],
      ['gone', 'Gone'],
      ['priceUp', 'Price rise'],
      ['changed', 'Changed'],
    ];
    const picked: WatchNotice['items'] = [];
    const lines: string[] = [];
    for (const [key, label] of order) {
      for (const id of s.changes[key]) {
        const i = byId.get(id);
        if (!i) continue;
        const was = key === 'priceDown' || key === 'priceUp' ? i.history.filter((h) => h.kind === 'price').at(-1)?.from : undefined;
        if (picked.length < NOTICE_ITEMS) {
          picked.push({ id, title: i.title, ...(i.price !== undefined ? { price: i.price } : {}), ...(i.priceText ? { priceText: i.priceText } : {}), ...(was !== undefined ? { was } : {}), mark: i.mark, ...(i.url ? { url: i.url } : {}), ...(i.image ? { image: true } : {}) });
        }
        if (lines.length < 4) lines.push(`${label}: ${i.title}${i.priceText || i.price !== undefined ? `, ${i.priceText ?? moneyWords(i.price!, spec.currency)}` : ''}${was !== undefined ? ` (was ${moneyWords(was, spec.currency)})` : ''}`);
      }
    }
    const changed = changedCount(s.counts) > 0;
    const head = changed ? s.words : countWords(s.counts, { still: true });
    const more = changedCount(s.counts) - lines.length;
    const body = [`${head}.`, ...lines.map((l) => `${l}.`), ...(more > 0 ? [`And ${more} more.`] : [])].join(' ');
    const watch: WatchNotice = { routineId: routine.id, runId: s.runId, counts: s.counts, items: picked, ...(spec.currency ? { currency: spec.currency } : {}) };
    return { title: routine.name, body, level: changed ? 'success' : 'info', ...(sessionId ? { sessionId } : {}), link: `/routines/${routine.id}`, watch } as Omit<Notice, 'id' | 'createdAt'>;
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private saveItems(routineId: string, items: WatchItem[], dropped: string[]): void {
    const tx = this.db.transaction(() => {
      const put = this.db.query('INSERT OR REPLACE INTO watch_items (routine_id, item_id, present, last_seen, data) VALUES (?, ?, ?, ?, ?)');
      for (const i of items) put.run(routineId, i.id, i.present ? 1 : 0, i.lastSeen, JSON.stringify(i));
      const del = this.db.query('DELETE FROM watch_items WHERE routine_id = ? AND item_id = ?');
      for (const id of dropped) del.run(routineId, id);
    });
    tx();
  }

  private saveRun(s: WatchRunSummary): void {
    this.db.query('INSERT OR REPLACE INTO watch_runs (routine_id, run_id, at, data) VALUES (?, ?, ?, ?)').run(s.routineId, s.runId, s.at, JSON.stringify(s));
    this.db.query('DELETE FROM watch_runs WHERE routine_id = ? AND run_id NOT IN (SELECT run_id FROM watch_runs WHERE routine_id = ? ORDER BY at DESC LIMIT ?)').run(s.routineId, s.routineId, RUNS_KEPT);
  }

  /** Everything a watch kept: rows and photos. Runs when its routine is deleted. */
  remove(routineId: string): void {
    this.db.query('DELETE FROM watch_items WHERE routine_id = ?').run(routineId);
    this.db.query('DELETE FROM watch_runs WHERE routine_id = ?').run(routineId);
    const dir = this.imageFolder(routineId);
    if (dir) rmSync(dir, { recursive: true, force: true });
    log.info(`watch ${routineId}: items, runs and photos removed`);
  }

  /** Rows of routines that are gone (deleted while this module was not loaded). */
  sweep(): void {
    const ids = new Set(this.opts.routines.list().map((r) => r.id));
    const kept = this.db.query('SELECT DISTINCT routine_id AS id FROM watch_items UNION SELECT DISTINCT routine_id AS id FROM watch_runs').all() as Row[];
    for (const r of kept) if (!ids.has(r.id)) this.remove(r.id);
    // photo folders whose rows went already (a photo that landed just after a delete)
    let folders: string[] = [];
    try {
      folders = readdirSync(this.opts.imageDir);
    } catch {
      return;
    }
    for (const f of folders) if (!ids.has(f) && this.imageFolder(f)) rmSync(join(this.opts.imageDir, f), { recursive: true, force: true });
  }

  /** Item and run counts, for tests and the backup size. */
  sizes(routineId: string): { items: number; runs: number; images: number } {
    const n = (sql: string) => (this.db.query(sql).get(routineId) as Row).n as number;
    const dir = this.imageFolder(routineId);
    return { items: n('SELECT COUNT(*) AS n FROM watch_items WHERE routine_id = ?'), runs: n('SELECT COUNT(*) AS n FROM watch_runs WHERE routine_id = ?'), images: dir && existsSync(dir) ? readdirSync(dir).length : 0 };
  }

  // -------------------------------------------------------------------------
  // Photos
  // -------------------------------------------------------------------------

  private imageFolder(routineId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(routineId)) return undefined;
    return join(this.opts.imageDir, routineId);
  }

  private imageFile(routineId: string, url: string): string | undefined {
    const dir = this.imageFolder(routineId);
    return dir ? join(dir, createHash('sha256').update(url).digest('hex').slice(0, 32)) : undefined;
  }

  /** Photos of items the watch no longer keeps. */
  private pruneImages(routineId: string, items: WatchItem[]): void {
    const dir = this.imageFolder(routineId);
    if (!dir || !existsSync(dir)) return;
    const keep = new Set(items.filter((i) => i.image).map((i) => basename(this.imageFile(routineId, i.image!)!)));
    for (const f of readdirSync(dir)) if (!keep.has(f.replace(/\.type$/, ''))) rmSync(join(dir, f), { force: true });
  }

  /**
   * An item's photo, fetched by the hub once and kept, so the cards work
   * where the site's photo links expire or the page's rules allow only https.
   * The hub fetches only http(s), only images, at most 3 MB, and reaches a
   * private or local address only when the watch's own site is there.
   */
  async image(routineId: string, itemId: string): Promise<{ type: string; bytes: Uint8Array }> {
    const r = this.opts.routines.get(routineId);
    const item = this.item(routineId, itemId);
    const url = item?.image && httpUrl(item.image);
    if (!r || !isWatch(r) || !url) throw new WatchError(404, 'That item has no photo.');
    const file = this.imageFile(routineId, url)!;
    if (existsSync(file) && existsSync(`${file}.type`)) return { type: readFileSync(`${file}.type`, 'utf8'), bytes: readFileSync(file) };
    const got = await this.fetchImage(url, new URL(r.watch.url).hostname, isMember(r.accountId));
    // deleted while the photo loaded: show it, keep nothing
    if (!this.opts.routines.get(routineId)) return got;
    const dir = this.imageFolder(routineId)!;
    mkdirSync(dir, { recursive: true });
    if (folderBytes(dir) + got.bytes.length <= IMAGE_DIR_CAP) {
      writeFileSync(file, got.bytes);
      writeFileSync(`${file}.type`, got.type);
    }
    return got;
  }

  /**
   * The photo of an item a chat showed (WatchReport in a chat), for its
   * card. Only items that session reported, with the same rules as a
   * watch's photos; the item's own page decides which private host is fine.
   */
  async draftImage(sessionId: string, itemId: string): Promise<{ type: string; bytes: Uint8Array }> {
    const item = this.draft(sessionId).find((i) => i.id === itemId);
    const url = item?.image && httpUrl(item.image);
    if (!item || !url) throw new WatchError(404, 'That item has no photo.');
    let site = '';
    try {
      site = item.url ? new URL(item.url).hostname : '';
    } catch {
      /* no page */
    }
    return this.fetchImage(url, site, isMember(currentAccount()));
  }

  /** member: a member's watch photo comes only from a public address, whatever its site (docs/design/ACCOUNTS.md 5). */
  private async fetchImage(url: string, siteHost: string, member = false): Promise<{ type: string; bytes: Uint8Array }> {
    const f = this.opts.fetch ?? fetch;
    let at = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(at);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WatchError(400, 'Photos load only over http or https.');
      if (privateHost(u.hostname) && (member || u.hostname !== siteHost)) throw new WatchError(403, 'That photo is on a private address the watch does not browse.');
      if (member) await checkPublicUrl(at).catch((err: Error) => {
        throw new WatchError(403, err.message);
      });
      let res: Response;
      try {
        res = await f(at, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } });
      } catch (err) {
        throw new WatchError(502, `Could not load the photo: ${(err as Error)?.message ?? String(err)}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        at = new URL(res.headers.get('location')!, at).toString();
        continue;
      }
      if (!res.ok) throw new WatchError(502, `The site answered ${res.status} for the photo.`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) throw new WatchError(502, 'The photo address did not return an image.');
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > IMAGE_MAX_BYTES) throw new WatchError(502, 'The photo is larger than 3 MB.');
      return { type, bytes: await readCapped(res, IMAGE_MAX_BYTES) };
    }
    throw new WatchError(502, 'The photo address redirects too often.');
  }
}

/**
 * A response body read up to max bytes. A site's photo may claim no length
 * and never end, so the hub stops reading past the limit instead of holding
 * all of it first.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => undefined);
        throw new WatchError(502, 'The photo is larger than 3 MB.');
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof WatchError) throw err;
    throw new WatchError(502, `Could not load the photo: ${(err as Error)?.message ?? String(err)}`);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function folderBytes(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    try {
      n += statSync(join(dir, f)).size;
    } catch {
      /* gone meanwhile */
    }
  }
  return n;
}

/** Loopback, private ranges, link-local, and names that only mean something at home. */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (!h.includes('.') && !isIP(h)) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}

/** "$6,500" for USD, "6,500 EUR" otherwise, plain "6,500" without a currency. */
export function moneyWords(n: number, currency?: string): string {
  const num = n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 });
  if (currency === 'USD') return `$${num}`;
  if (currency === 'GBP') return `£${num}`;
  if (currency === 'EUR') return `€${num}`;
  return currency ? `${num} ${currency}` : num;
}

export type { WatchCounts };
