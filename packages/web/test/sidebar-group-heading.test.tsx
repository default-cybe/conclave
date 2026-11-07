/**
 * The sidebar's group headings (Today, Yesterday, a project, a device) read
 * as section labels, not session rows (Sidebar.tsx GroupHeading,
 * docs/design/SPEC.md 5.3): an h3 with a fold button, `meta` 600 in
 * `--fg-3`, no hover fill, never uppercase.
 *
 *   cd packages/web && bun test test/sidebar-group-heading.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const { GroupHeading } = await import('../src/components/Sidebar');
const draw = (folded: boolean, phone = false) => renderToStaticMarkup(<GroupHeading label="Yesterday" folded={folded} onToggle={() => undefined} phone={phone} />);

describe('GroupHeading', () => {
  test('is a level 3 heading whose button folds the group', () => {
    const out = draw(false);
    expect(out).toMatch(/^<div[^>]*><h3[^>]*><button[^>]*aria-expanded="true"/);
    expect(out).toContain('Yesterday');
    expect(draw(true)).toContain('aria-expanded="false"');
  });

  test('looks like a label: semibold fg-3 at the meta size, no row hover fill, no uppercase', () => {
    const out = draw(false);
    expect(out).toContain('font-semibold');
    expect(out).toContain('text-fg-3');
    expect(out).toContain('text-[12px]');
    expect(draw(false, true)).toContain('text-[13px]');
    expect(out).not.toContain('bg-side-hover');
    expect(out).not.toContain('uppercase');
    // smaller than the 13.5px session rows
    expect(out).not.toContain('text-[13.5px]');
  });
});
