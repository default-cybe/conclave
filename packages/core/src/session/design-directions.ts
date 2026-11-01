/**
 * The design directions an owner can pick for UI work in a Code session
 * (/design). Plain data with no Node imports, so the web app shows the same
 * list the hub turns into a brief (session/design-brief.ts).
 */
export type DesignDirection = 'system' | 'minimal' | 'editorial' | 'dense' | 'playful' | 'reference';

export interface DesignPick {
  direction: DesignDirection;
  /** Match a reference: a page to look at. */
  url?: string;
  /** Match a reference: an uploaded screenshot; its bytes are in kv (designImageKey). */
  image?: { name: string; mediaType: string };
}

/** What a client sends: the screenshot with its bytes. Image left out keeps the stored one; null drops it. */
export interface DesignInput {
  direction: DesignDirection;
  url?: string;
  image?: { name?: string; mediaType: string; data: string } | null;
}

export const DESIGN_DIRECTIONS: Array<{ id: DesignDirection; label: string; detail: string; brief: string }> = [
  {
    id: 'system',
    label: "This app's design system",
    detail: 'Its own tokens, components and design docs.',
    brief: "Follow the project's own design system: read its design docs (such as DESIGN.md or docs/design/), tokens and two screens like the one you change, then compose what exists. Add no new token, font, color or dependency.",
  },
  {
    id: 'minimal',
    label: 'Minimal',
    detail: 'Few elements, whitespace, one accent at most.',
    brief: 'Minimal: few elements, generous whitespace, a plain type hierarchy and one accent color at most. Remove decoration before you add any.',
  },
  {
    id: 'editorial',
    label: 'Editorial',
    detail: 'Type-led, like a well set magazine page.',
    brief: 'Editorial: type leads. A clear type scale, a measured text column, rules and whitespace instead of boxes and cards.',
  },
  {
    id: 'dense',
    label: 'Dense dashboard',
    detail: 'Compact rows, aligned numbers, little padding.',
    brief: 'Dense dashboard: information first. Compact rows, aligned columns, tabular numbers, small type and little padding; no hero areas or large empty space.',
  },
  {
    id: 'playful',
    label: 'Playful',
    detail: 'Warmer color, rounder shapes, light motion.',
    brief: 'Playful: warmer color, rounder shapes, friendly copy and light motion that respects prefers-reduced-motion. It stays readable, with enough contrast.',
  },
  {
    id: 'reference',
    label: 'Match a reference',
    detail: 'A page or a screenshot to match.',
    brief: 'Match the reference below: its layout, spacing, type and color, adapted to this project. Copy the look, not its text, logos or images.',
  },
];

/** A reference screenshot's size limit, decoded. */
export const DESIGN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The design pick on a session's meta, if any. */
export function readDesign(meta: Record<string, unknown> | undefined): DesignPick | undefined {
  const d = meta?.design as Partial<DesignPick> | undefined;
  if (!d || !DESIGN_DIRECTIONS.some((x) => x.id === d.direction)) return undefined;
  return { direction: d.direction!, ...(typeof d.url === 'string' ? { url: d.url } : {}), ...(d.image && typeof d.image.mediaType === 'string' ? { image: { name: String(d.image.name ?? 'screenshot'), mediaType: d.image.mediaType } } : {}) };
}
