/**
 * Turns messages and live events into display items, and decides which items
 * are final so they can move into Ink's <Static> (printed once, never redrawn).
 *
 * Items are committed strictly in order: the first item that can still change
 * (a streaming paragraph, a running tool) holds back everything after it.
 * Streaming text is cut at blank lines outside code fences so finished
 * paragraphs commit while the model keeps writing.
 */
import type { ContentBlock, Message, ToolResultBlock } from '@conclave/core/types.ts';
import { isReminder } from '@conclave/core/session/transcript.ts';

export type ToolStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'interrupted';

export type Item =
  | { kind: 'banner'; id: string; final: true; lines: string[] }
  | { kind: 'user'; id: string; final: true; text: string; attachments: number }
  | { kind: 'text'; id: string; final: boolean; text: string; model?: string; first: boolean; aside: boolean }
  | { kind: 'thinking'; id: string; final: boolean; text: string; model?: string }
  | { kind: 'label'; id: string; final: true; text: string; model?: string }
  | {
      kind: 'tool';
      id: string;
      final: boolean;
      name: string;
      input: Record<string, unknown>;
      status: ToolStatus;
      result?: ToolResultBlock;
      progress?: string;
      startedAt?: number;
      aside: boolean;
    }
  | { kind: 'notice'; id: string; final: true; text: string; level: 'info' | 'success' | 'warning' | 'error' }
  | { kind: 'summary'; id: string; final: true; text: string }
  /** "Why this turn stopped" (core session/stop-card.ts). */
  | { kind: 'stop'; id: string; final: true; title: string; evidence: string; next: string; tone: 'error' | 'warning' | 'info' }
  | { kind: 'info'; id: string; final: true; text: string; gap?: boolean };

export type LocalItem = Extract<Item, { kind: 'info' | 'notice' | 'banner' | 'user' | 'stop' }>;

type Entry = { type: 'msg'; id: string; seq: number } | { type: 'local'; item: Item } | { type: 'tool'; id: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** New paragraph boundaries (char offsets) in streaming text after `from`. */
export function findBoundaries(text: string, from: number): number[] {
  const out: number[] = [];
  // fence state at `from`
  let inFence = false;
  let fenceChar = '';
  let pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = pos;
    pos += line.length + 1;
    const f = FENCE.exec(line);
    if (f) {
      if (!inFence) {
        inFence = true;
        fenceChar = f[1][0];
      } else if (f[1][0] === fenceChar && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) inFence = false;
    }
    // boundary: an empty line outside a fence, followed by more text (so the line is complete)
    if (!inFence && line.trim() === '' && i > 0 && lines[i - 1].trim() !== '' && pos < text.length) {
      const b = start + line.length + 1;
      if (b > from) out.push(b);
    }
  }
  return out;
}

export class TranscriptStore {
  private messages = new Map<string, Message>();
  private timeline: Entry[] = [];
  private streaming = new Set<string>();
  private results = new Map<string, ToolResultBlock>();
  private progress = new Map<string, string>();
  private started = new Map<string, number>();
  private standalone = new Map<string, { name: string; input: Record<string, unknown> }>();
  private toolsInMessages = new Set<string>();
  private boundaries = new Map<string, number[]>();
  private groups = new Set<string>();
  private labels = new Map<string, string>();
  private waiting = new Set<string>();
  private active = false;
  private localSeq = 0;

  committed: Item[] = [];
  private cursor = 0;
  private partial = 0;

  /** Forget everything (new session). */
  clear(): void {
    this.messages.clear();
    this.timeline = [];
    this.streaming.clear();
    this.results.clear();
    this.progress.clear();
    this.started.clear();
    this.standalone.clear();
    this.toolsInMessages.clear();
    this.boundaries.clear();
    this.groups.clear();
    this.labels.clear();
    this.waiting.clear();
    this.committed = [];
    this.cursor = 0;
    this.partial = 0;
  }

  /**
   * Start committing again from scratch (after the screen is cleared). Only
   * the last `maxEntries` timeline entries are shown again.
   */
  recommit(maxEntries = 150): void {
    this.committed = [];
    this.partial = 0;
    const start = Math.max(0, this.timeline.length - maxEntries);
    this.cursor = start;
    if (start > 0) {
      this.committed.push({ kind: 'info', id: `hidden-${++this.localSeq}`, final: true, text: `\x1b[2m… ${start} earlier entries not shown (/export for the full transcript)\x1b[22m` });
    }
  }

  get messageCount(): number {
    return this.messages.size;
  }

  getMessages(): Message[] {
    return this.timeline.filter((e): e is Extract<Entry, { type: 'msg' }> => e.type === 'msg').map((e) => this.messages.get(e.id)!);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.streaming.clear();
      this.waiting.clear();
    }
  }

  setWaiting(toolUseIds: string[]): void {
    this.waiting = new Set(toolUseIds);
  }

  /** Initial load (resume). The last assistant message streams on if the session is running. */
  load(messages: Message[], running: boolean): void {
    const sorted = [...messages].sort((a, b) => a.seq - b.seq);
    for (const m of sorted) this.upsert(m, false);
    if (running) {
      const last = [...sorted].reverse().find((m) => m.role === 'assistant');
      if (last && !last.stopReason) this.streaming.add(last.id);
    }
  }

  upsert(m: Message, created: boolean): void {
    const existed = this.messages.has(m.id);
    this.messages.set(m.id, m);
    for (const b of m.content) {
      if (b.type === 'tool_result') this.results.set(b.toolUseId, b);
      if (b.type === 'tool_use') this.toolsInMessages.add(b.id);
    }
    if (m.kind === 'aside' && m.group) this.groups.add(m.group);
    if (!existed) this.insertEntry({ type: 'msg', id: m.id, seq: m.seq });
    if (m.stopReason) this.streaming.delete(m.id);
    else if (created && m.role === 'assistant' && m.kind !== 'notice' && m.kind !== 'summary' && this.active) this.streaming.add(m.id);
  }

  private insertEntry(e: Extract<Entry, { type: 'msg' }>): void {
    const min = this.cursor + (this.partial > 0 ? 1 : 0);
    // Jury and debate: asides go before a verdict of the same group that is still open.
    const m = this.messages.get(e.id);
    if (m?.kind === 'aside' && m.group) {
      for (let j = min; j < this.timeline.length; j++) {
        const t = this.timeline[j];
        if (t.type !== 'msg') continue;
        const v = this.messages.get(t.id);
        if (v && v.role === 'assistant' && v.kind === 'normal' && v.group === m.group) {
          this.timeline.splice(j, 0, e);
          return;
        }
      }
    }
    // keep seq order among entries that are not committed yet
    let i = this.timeline.length;
    while (i > min) {
      const prev = this.timeline[i - 1];
      if (prev.type === 'msg' && prev.seq > e.seq) i--;
      else break;
    }
    this.timeline.splice(i, 0, e);
  }

  delta(ev: { messageId: string; sessionId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }): void {
    let m = this.messages.get(ev.messageId);
    if (!m) {
      const maxSeq = Math.max(0, ...[...this.messages.values()].map((x) => x.seq));
      m = { id: ev.messageId, sessionId: ev.sessionId, seq: maxSeq + 1, role: 'assistant', kind: 'normal', content: [], createdAt: Date.now() };
      this.messages.set(m.id, m);
      this.insertEntry({ type: 'msg', id: m.id, seq: m.seq });
    }
    if (ev.kind === 'tool_input') {
      this.streaming.add(m.id);
      return;
    }
    const content = [...m.content];
    while (content.length <= ev.index) content.push(ev.kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' });
    const b = content[ev.index];
    if (b.type === 'text') content[ev.index] = { ...b, text: b.text + ev.text };
    else if (b.type === 'thinking') content[ev.index] = { ...b, thinking: b.thinking + ev.text };
    else content[ev.index] = ev.kind === 'thinking' ? { type: 'thinking', thinking: ev.text } : { type: 'text', text: ev.text };
    this.messages.set(m.id, { ...m, content });
    this.streaming.add(m.id);
  }

  toolStarted(toolUseId: string, name: string, input: Record<string, unknown>): void {
    if (!this.started.has(toolUseId)) this.started.set(toolUseId, Date.now());
    if (!this.toolsInMessages.has(toolUseId) && !this.standalone.has(toolUseId)) {
      this.standalone.set(toolUseId, { name, input });
      this.timeline.push({ type: 'tool', id: toolUseId });
    }
  }

  toolProgress(toolUseId: string, text: string): void {
    const prev = this.progress.get(toolUseId) ?? '';
    const next = prev + text;
    this.progress.set(toolUseId, next.length > 4000 ? next.slice(-4000) : next);
  }

  toolCompleted(toolUseId: string, result: ToolResultBlock): void {
    this.results.set(toolUseId, result);
  }

  addLocal(item: LocalItem | Omit<LocalItem, 'id' | 'final'>): void {
    const full = { ...item, id: (item as LocalItem).id ?? `local-${++this.localSeq}`, final: true } as Item;
    this.timeline.push({ type: 'local', item: full });
  }

  // ---------------------------------------------------------------------------

  private toolItem(id: string, name: string, input: Record<string, unknown>, messageFinal: boolean, aside: boolean): Item {
    const result = this.results.get(id);
    let status: ToolStatus;
    if (result) status = result.isError ? 'error' : 'done';
    else if (this.waiting.has(id)) status = 'waiting';
    else if (this.started.has(id)) status = this.active ? 'running' : 'interrupted';
    else status = this.active || !messageFinal ? 'pending' : 'interrupted';
    const final = status === 'done' || status === 'error' || status === 'interrupted';
    return { kind: 'tool', id: `tool:${id}`, final, name, input, status, result, progress: this.progress.get(id), startedAt: this.started.get(id), aside };
  }

  private textChunks(m: Message, bi: number, text: string, blockFinal: boolean, first: boolean, aside: boolean): Item[] {
    const key = `${m.id}:${bi}`;
    let bounds = this.boundaries.get(key) ?? [];
    if (!blockFinal) {
      const fresh = findBoundaries(text, bounds[bounds.length - 1] ?? 0);
      if (fresh.length) {
        bounds = [...bounds, ...fresh];
        this.boundaries.set(key, bounds);
      }
    }
    const items: Item[] = [];
    let prev = 0;
    bounds.forEach((b, k) => {
      const chunk = text.slice(prev, b).replace(/\n+$/, '');
      if (chunk.trim()) items.push({ kind: 'text', id: `${key}:${k}`, final: true, text: chunk, model: m.model, first: first && items.length === 0, aside });
      prev = b;
    });
    const tail = text.slice(prev);
    if (tail.trim() || (!blockFinal && items.length === 0)) {
      items.push({ kind: 'text', id: `${key}:${bounds.length}`, final: blockFinal, text: tail.replace(/\s+$/, ''), model: m.model, first: first && items.length === 0, aside });
    }
    return items;
  }

  private itemsForMessage(m: Message): Item[] {
    const streaming = this.streaming.has(m.id);
    const texts = (blocks: ContentBlock[]) =>
      blocks
        // hub context for the model (recalled notes, hook output, task results) is not the owner's words
        .filter((b) => b.type === 'text' && !isReminder(b))
        .map((b) => (b as { text: string }).text)
        .join('\n');
    if (m.kind === 'notice') {
      const text = texts(m.content);
      const level = (m.meta?.level as 'info' | 'warning' | 'error' | 'success') ?? (/^error\b/i.test(text) ? 'error' : 'info');
      return [{ kind: 'notice', id: `${m.id}:n`, final: true, text, level }];
    }
    if (m.kind === 'summary') return [{ kind: 'summary', id: `${m.id}:s`, final: true, text: texts(m.content) }];
    if (m.role === 'user') {
      const text = texts(m.content);
      const attachments = m.content.filter((b) => b.type === 'image' || b.type === 'document').length;
      if (!text.trim() && !attachments) return [];
      return [{ kind: 'user', id: `${m.id}:u`, final: true, text, attachments }];
    }
    // Nothing to show yet; keeping it empty also leaves the entry free to move (see insertEntry).
    if (m.content.length === 0) return [];
    const items: Item[] = [];
    const aside = m.kind === 'aside';
    // Decide the label once so item positions never shift after a commit.
    let label = this.labels.get(m.id);
    if (label === undefined) {
      label = aside ? (m.author ?? 'Aside') : m.author || (m.group && this.groups.has(m.group) ? 'Verdict' : '');
      this.labels.set(m.id, label);
    }
    if (label) items.push({ kind: 'label', id: `${m.id}:l`, final: true, text: label, model: m.model });
    const lastIndex = m.content.length - 1;
    let firstText = !aside;
    m.content.forEach((b, i) => {
      const blockFinal = !streaming || i < lastIndex;
      if (b.type === 'text') {
        if (!b.text.trim() && blockFinal) return;
        const chunks = this.textChunks(m, i, b.text, blockFinal, firstText, aside);
        if (chunks.length) firstText = false;
        items.push(...chunks);
      } else if (b.type === 'thinking') {
        if (b.thinking.trim() || !blockFinal) items.push({ kind: 'thinking', id: `${m.id}:${i}:t`, final: blockFinal, text: b.thinking, model: m.model });
      } else if (b.type === 'redacted_thinking') {
        items.push({ kind: 'thinking', id: `${m.id}:${i}:t`, final: true, text: '(redacted)', model: m.model });
      } else if (b.type === 'tool_use') {
        if (this.standalone.has(b.id)) return;
        items.push(this.toolItem(b.id, b.name, b.input, !streaming, aside));
      } else if (b.type === 'image' || b.type === 'document') {
        items.push({ kind: 'info', id: `${m.id}:${i}:a`, final: true, text: `[${b.type}]` });
      }
    });
    return items;
  }

  private itemsFor(e: Entry): { items: Item[]; closed: boolean } {
    if (e.type === 'local') return { items: [e.item], closed: true };
    if (e.type === 'tool') {
      const t = this.standalone.get(e.id)!;
      const item = this.toolItem(e.id, t.name, t.input, true, false);
      return { items: [item], closed: item.final };
    }
    const m = this.messages.get(e.id);
    if (!m) return { items: [], closed: true };
    const items = this.itemsForMessage(m);
    return { items, closed: !this.streaming.has(m.id) && items.every((i) => i.final) };
  }

  /** Commit newly final items and return what is still live. */
  build(): { committed: Item[]; live: Item[]; changed: boolean } {
    const live: Item[] = [];
    let canCommit = true;
    const before = this.committed.length;
    for (let e = this.cursor; e < this.timeline.length; e++) {
      const { items, closed } = this.itemsFor(this.timeline[e]);
      const skip = e === this.cursor ? this.partial : 0;
      let k = skip;
      if (canCommit) {
        while (k < items.length && items[k].final) this.committed.push(items[k++]);
        if (k === items.length && closed) {
          if (e === this.cursor) {
            this.cursor = e + 1;
            this.partial = 0;
          }
          continue;
        }
        // first entry that cannot fully commit: remember how far it got
        this.cursor = e;
        this.partial = k;
        canCommit = false;
      }
      for (; k < items.length; k++) live.push(items[k]);
    }
    return { committed: this.committed, live, changed: this.committed.length !== before };
  }
}
