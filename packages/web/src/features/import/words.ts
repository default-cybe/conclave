/** Words for the chat import screens: sources, modes, state words and batch lines. */
import type { ExternalSessionInfo, ImportBatch, ImportEstimate, ImportMode, ImportSource, SessionImportInfo } from '@conclave/core/client';
import { modelName } from '@/lib/models';
import { countWord, hhmm, plural, shortDate, usd } from '@/lib/format';

export const SOURCE_NAME: Record<ImportSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  'claude-ai': 'claude.ai',
  chatgpt: 'ChatGPT',
};

/** The harness logo id for a source, when it has one. */
export const SOURCE_HARNESS: Partial<Record<ImportSource, string>> = { 'claude-code': 'claude-code', codex: 'codex', gemini: 'gemini-cli', opencode: 'opencode' };

export const MODES: Array<{ value: ImportMode; label: string; short: string }> = [
  { value: 'chats', label: 'Chats only', short: 'Chats' },
  { value: 'chats-learn', label: 'Chats and learn memory', short: 'Chats and memory' },
  { value: 'learn', label: 'Learn memory only', short: 'Memory' },
];

export const MODE_HELP: Record<ImportMode, string> = {
  chats: 'The chats become archived sessions you can search and resume. Nothing is sent to a model.',
  'chats-learn': 'The chats become archived sessions, then a small model reads each one and keeps what a future agent should know. Every item must quote the chat.',
  learn: 'A small model reads the chats and keeps what a future agent should know. No sessions are made.',
};

const SKIP: Record<NonNullable<ExternalSessionInfo['skip']>, string> = {
  automation: 'skipped, automation',
  subagent: 'skipped, subagent',
  internal: 'skipped, internal',
  'too-short': 'skipped, too short',
};

export type Tone = 'ok' | 'warn' | 'fault' | 'signal' | 'dim' | 'neutral';

/** The state word at the end of a scan row. */
export function rowState(x: ExternalSessionInfo): { word: string; tone: Tone } {
  if (x.imported?.state === 'diverged') return { word: 'continued in both places', tone: 'warn' };
  if (x.imported?.state === 'behind') return { word: x.imported.newThere ? `${x.imported.newThere} new there` : 'has new messages', tone: 'neutral' };
  // learned in "Learn memory only": there is no session for it yet, so it can still be imported
  if (x.imported && !x.imported.sessionId) return { word: x.imported.learned ? 'learned, not imported' : 'new', tone: x.imported.learned ? 'dim' : 'neutral' };
  if (x.imported) return { word: x.imported.learned ? 'imported, learned' : 'imported', tone: 'dim' };
  if (x.skip) return { word: SKIP[x.skip], tone: 'dim' };
  return { word: 'new', tone: 'neutral' };
}

const STATUS: Record<ImportBatch['status'], { word: string; tone: Tone }> = {
  scanning: { word: 'reading', tone: 'signal' },
  importing: { word: 'importing', tone: 'signal' },
  learning: { word: 'learning', tone: 'signal' },
  consolidating: { word: 'tidying memory', tone: 'signal' },
  paused: { word: 'paused', tone: 'warn' },
  waiting_reset: { word: 'waiting for reset', tone: 'dim' },
  done: { word: 'done', tone: 'ok' },
  failed: { word: 'failed', tone: 'fault' },
  cancelled: { word: 'cancelled', tone: 'dim' },
  undone: { word: 'undone', tone: 'dim' },
};

export function batchState(b: ImportBatch): { word: string; tone: Tone } {
  if (b.status === 'waiting_reset' && b.resumeAt) return { word: `resumes ${hhmm(b.resumeAt)}`, tone: 'dim' };
  return STATUS[b.status];
}

export function deviceWord(device: string, names: Record<string, string>): string {
  if (device.startsWith('upload:')) return 'an uploaded export';
  return names[device] ?? device;
}

/** "Chats and learn memory, 212 chats from arch-desktop" */
export function batchTitle(b: ImportBatch, names: Record<string, string>): string {
  const mode = MODES.find((m) => m.value === b.mode)!.label;
  return `${mode}, ${plural(b.total, 'chat')} from ${deviceWord(b.device, names)}`;
}

/** "180 imported, 12 updated, 41 memories, 6 to review, $0.58" */
export function batchCounts(b: ImportBatch): string[] {
  const parts: string[] = [];
  if (b.imported) parts.push(`${b.imported} imported`);
  if (b.updated) parts.push(`${b.updated} updated`);
  if (b.forked) parts.push(`${b.forked} continued in both places`);
  if (b.unchanged) parts.push(`${b.unchanged} already here`);
  if (b.skipped) parts.push(`${b.skipped} skipped`);
  if (b.failed) parts.push(`${b.failed} failed`);
  if (b.mode !== 'chats') {
    if (b.learnedSessions) parts.push(`${plural(b.learnedSessions, 'chat')} read`);
    if (b.memoriesAdded) parts.push(plural(b.memoriesAdded, 'memory', 'memories'));
    if (b.memoriesMerged) parts.push(`${b.memoriesMerged} merged`);
    if (b.memoriesInNotes) parts.push(`${b.memoriesInNotes} already in your notes`);
    if (b.memoriesReview) parts.push(`${b.memoriesReview} to review`);
    if (b.costUsd) parts.push(usd(b.costUsd, { precise: true }));
  }
  return parts;
}

/** How far a running batch got, for its live line. */
export function batchProgress(b: ImportBatch): { done: number; total: number; verb: string } {
  const copied = b.imported + b.updated + b.forked + b.unchanged + b.skipped + b.failed;
  if (b.status === 'learning' || b.status === 'consolidating' || (b.mode === 'learn' && b.status !== 'importing')) {
    const total = Math.max(1, b.mode === 'learn' ? b.total : b.total - b.skipped - b.failed);
    return { done: Math.min(total, b.learnedSessions), total, verb: b.status === 'consolidating' ? 'Tidying memory' : 'Learning' };
  }
  return { done: Math.min(b.total, copied), total: b.total, verb: 'Importing' };
}

/** Why items were dropped, as words. */
export function droppedWords(d: Record<string, number>): string {
  const names: Record<string, string> = {
    evidence: 'the quote was not in the chat',
    basis: 'no clear basis',
    kind: 'unknown kind',
    length: 'too long',
    secret: 'looked like a secret',
    duplicate: 'said twice',
    supersedes: 'replaced nothing',
    'not-json': 'unreadable reply',
    shape: 'unreadable item',
    'evidence-role': 'the quote was not the owner or a tool',
    'evidence-unrelated': 'the quote did not back it',
    number: 'a number not in the chat',
    order: 'an order, not a fact',
  };
  return Object.entries(d)
    .filter(([k, n]) => n > 0 && names[k])
    .map(([k, n]) => `${n} ${names[k]}`)
    .join(', ');
}

/** "212 chats, about $0.61 on Haiku 5.5" plus the other options. */
export function estimateLine(e: ImportEstimate, mode: ImportMode): { lead: string; rest?: string } {
  const chats = plural(e.sessions, 'chat');
  if (!e.sessions) return { lead: 'Nothing to import with these filters.' };
  if (mode === 'chats') {
    const already = e.alreadyImported ? `, ${e.alreadyImported} already here` : '';
    return { lead: `${chats}${already}. Nothing is sent to a model.` };
  }
  const first = e.options[0];
  const price = (o: ImportEstimate['options'][number]) => (o.free ? `free on ${modelName(o.model)}` : `about ${usd(o.costUsd, { precise: true })} on ${modelName(o.model)}`);
  const lead = first ? `${chats}, ${price(first)}.` : `${chats}.`;
  const others = e.options.slice(1).map(price);
  return { lead, rest: others.length ? `Or ${others.join(', ')}.` : undefined };
}

export function skippedLine(e: ImportEstimate): string {
  const s = e.skipped;
  const parts = [s['too-short'] ? `${s['too-short']} too short` : '', s.automation ? `${s.automation} automation` : '', s.subagent ? `${s.subagent} subagent` : '', s.internal ? `${s.internal} internal` : ''].filter(Boolean);
  const n = Object.values(s).reduce((a, b) => a + (b ?? 0), 0);
  return n ? `${countWord(n, true)} skipped: ${parts.join(', ')}.` : '';
}

/** "Imported from Claude Code on arch-desktop, 14 March." */
export function importedLine(info: SessionImportInfo, names: Record<string, string>): string {
  const when = info.createdAt ?? info.importedAt;
  const d = new Date(when);
  const day = `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`;
  const where = info.device.startsWith('upload:') ? 'an export' : (names[info.device] ?? info.device);
  return info.source === 'claude-ai' || info.source === 'chatgpt' ? `Imported from a ${SOURCE_NAME[info.source]} export, ${day}.` : `Imported from ${SOURCE_NAME[info.source]} on ${where}, ${day}.`;
}

export function dateRange(a: number, b: number): string {
  const x = shortDate(a);
  const y = shortDate(b);
  return x === y ? x : `${x} to ${y}`;
}
