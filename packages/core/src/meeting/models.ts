/**
 * The live answer model: the picker list (GET /api/meetings/models) and the
 * default when a meeting has no answerModel. Live answers need the first word
 * fast, so the default is models.tiers.fast when set, else the fastest usable
 * Haiku or Gemini Flash, and a note says so when it has to be something slower.
 */
import type { ModelGroup } from '../client/index';
import type { MeetingModelOption } from './wire';

type Speed = MeetingModelOption['speed'];

/** Rough speed of a model by its id and catalog tier. */
export function speedOf(id: string, tier?: string): Speed {
  const s = id.toLowerCase();
  if (/flash-lite|flash-8b|haiku|nano|lite/.test(s)) return 'fastest';
  if (/flash|mini|small|fast/.test(s) || tier === 'fast') return 'fast';
  if (/opus|pro\b|-pro|ultra|deep/.test(s) || tier === 'deep') return 'best';
  return 'balanced';
}

const NOTES: Record<Speed, string> = {
  fastest: 'Quickest first word. Good for most meetings and interviews.',
  fast: 'Quick, a little more careful.',
  balanced: 'Slower first word; better on hard technical questions.',
  best: 'Slowest first word. Use for prep, not live answers, unless answers can wait.',
};
const RANK: Record<Speed, number> = { fastest: 0, fast: 1, balanced: 2, best: 3 };

/** Candidates for the default, best first: Gemini Flash Lite, Haiku, Gemini Flash. */
function defaultRank(id: string): number {
  const s = id.toLowerCase();
  if (/gemini.*flash-lite/.test(s)) return 0;
  if (/haiku/.test(s)) return 1;
  if (/gemini.*flash/.test(s)) return 2;
  return -1;
}

/** The picker list from the account's model groups: chat models only, fastest first. */
export function modelOptions(groups: ModelGroup[], usable: (ref: string) => boolean): MeetingModelOption[] {
  const seen = new Set<string>();
  const out: MeetingModelOption[] = [];
  for (const g of groups) {
    // a harness (claude-code, codex) runs a whole agent: never a live answer
    if (g.type === 'acp' || !g.enabled || !g.configured) continue;
    for (const m of g.models) {
      if (m.sameAs || seen.has(m.ref) || !usable(m.ref)) continue;
      seen.add(m.ref);
      const speed = speedOf(m.id, m.tier);
      out.push({ ref: m.ref, label: m.name || m.id, speed, note: NOTES[speed] });
    }
  }
  return out.sort((a, b) => RANK[a.speed] - RANK[b.speed] || a.label.localeCompare(b.label));
}

/** The default from the picker list: the tier the owner set, else the best candidate; undefined when there is none. */
export function defaultLiveModel(options: MeetingModelOption[], tierFast: string | undefined, usable: (ref: string) => boolean): string | undefined {
  if (tierFast && usable(tierFast)) return tierFast;
  let best: { ref: string; rank: number } | undefined;
  for (const o of options) {
    const r = defaultRank(o.ref.slice(o.ref.lastIndexOf('/') + 1));
    if (r >= 0 && (!best || r < best.rank)) best = { ref: o.ref, rank: r };
  }
  return best?.ref ?? options.find((o) => o.speed === 'fastest')?.ref;
}
