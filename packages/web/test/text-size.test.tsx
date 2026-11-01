/**
 * Text size (Settings > Appearance, lib/textSize.ts, CHAT-AND-MOTION 6.5):
 * the choice is kept on this device with the rest of the appearance, sets
 * --text-scale on <html> (and before first paint, public/theme.js), and
 * only a conversation (.log-text) reads it.
 *
 *   bun test packages/web/test/text-size.test.tsx
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyTextSize, TEXT_SIZES, textScale, textSizeOf } from '../src/lib/textSize';
import { useUi } from '../src/store/ui';
import { TextSizeRow } from '../src/features/settings/app';

const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A stand-in for <html>: its data attributes and its inline style's custom properties. */
function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => {
        props.delete(k);
        return '';
      },
      getPropertyValue: (k: string) => props.get(k) ?? '',
    },
  };
}

describe('the sizes', () => {
  test('Small, Default, Large and Larger, smallest first, Default at 1', () => {
    expect(TEXT_SIZES.map((s) => s.label)).toEqual(['Small', 'Default', 'Large', 'Larger']);
    expect(TEXT_SIZES.map((s) => s.scale)).toEqual([0.875, 1, 1.125, 1.25]);
    expect(textScale('default')).toBe(1);
  });

  test('a stored value that is not a size reads as the default', () => {
    expect(textSizeOf('large')).toBe('large');
    expect(textSizeOf(undefined)).toBe('default');
    expect(textSizeOf('huge')).toBe('default');
    expect(textSizeOf(1.25)).toBe('default');
  });

  test('a size is a CSS variable on the root', () => {
    const root = fakeRoot();
    applyTextSize(root, 'larger');
    expect(root.props.get('--text-scale')).toBe('1.25');
    applyTextSize(root, 'small');
    expect(root.props.get('--text-scale')).toBe('0.875');
  });
});

describe('the setting on this device', () => {
  const g = globalThis as { localStorage?: unknown; document?: unknown };
  const before = { localStorage: g.localStorage, document: g.document, had: { localStorage: 'localStorage' in g, document: 'document' in g } };
  afterEach(() => {
    for (const k of ['localStorage', 'document'] as const) {
      if (before.had[k]) g[k] = before[k];
      else delete g[k];
    }
  });

  test('is kept with the appearance and sets --text-scale at once', () => {
    const stored = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
    const root = fakeRoot();
    g.document = { documentElement: root, querySelector: () => null };
    const was = useUi.getState().textSize;

    useUi.getState().set({ textSize: 'large' });
    expect(JSON.parse(stored.get('conclave.appearance') ?? '{}').textSize).toBe('large');
    expect(root.props.get('--text-scale')).toBe('1.125');

    useUi.getState().set({ textSize: 'default' });
    expect(JSON.parse(stored.get('conclave.appearance') ?? '{}').textSize).toBe('default');
    expect(root.props.get('--text-scale')).toBe('1');

    useUi.getState().set({ textSize: was });
  });

  test('is on the page before first paint (public/theme.js), with the same scales', () => {
    const src = file('public/theme.js');
    const run = (appearance: unknown) => {
      const root = fakeRoot();
      const doc = { documentElement: root, querySelector: () => null };
      const storage = { getItem: () => JSON.stringify(appearance) };
      new Function('document', 'localStorage', 'matchMedia', src)(doc, storage, () => ({ matches: false }));
      return root.props.get('--text-scale');
    };
    for (const s of TEXT_SIZES) expect(run({ textSize: s.value })).toBe(s.value === 'default' ? undefined : String(s.scale));
    // none yet, or a value that is not a size: the stylesheet's 1
    expect(run({ theme: 'dark' })).toBeUndefined();
    expect(run({ textSize: 'constructor' })).toBeUndefined();
  });
});

describe('the stylesheet', () => {
  const css = file('src/styles/index.css');

  test('reads 15px on a desktop and 16px on a phone by default', () => {
    expect(css).toMatch(/:root \{[^}]*--read-base: 15px;[^}]*--read-leading: 1\.6;/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*:root \{[^}]*--read-base: 16px;[^}]*--read-leading: 1\.55;/);
    expect(css).toMatch(/--text-scale: 1;/);
  });

  test('scales a conversation only: .log-text multiplies the reading size and sets the scale for its rows', () => {
    const block = /\.log-text \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('--log-scale: var(--text-scale);');
    expect(block).toContain('--read-size: calc(var(--read-base) * var(--text-scale));');
    // the pieces a conversation shares with the rest of the app scale only inside it
    expect(css).toMatch(/@utility tx-\* \{\s*font-size: calc\(var\(--log-scale, 1\) \* --value\(number\) \* 1px\);/);
    expect(css).toMatch(/@utility t-code \{[^}]*font-size: calc\(12\.5px \* var\(--log-scale, 1\)\);/);
  });

  test('every transcript carries .log-text', () => {
    for (const p of ['src/features/chat/MessageList.tsx', 'src/features/chat/PhoneTranscript.tsx', 'src/features/conversation/ChatMessages.tsx']) {
      expect(file(p)).toMatch(/className="log-text [^"]*" role="log"/);
    }
  });
});

describe('the row in Settings', () => {
  test('offers the four sizes and a reply line at the size picked', () => {
    const html = renderToStaticMarkup(<TextSizeRow value="small" onChange={() => {}} size="sm" />);
    expect(html).toContain('Text size');
    for (const w of ['Small', 'Default', 'Large', 'Larger']) expect(html).toContain(`>${w}<`);
    expect(html).toMatch(/data-text-preview="" class="log-text t-chat/);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
