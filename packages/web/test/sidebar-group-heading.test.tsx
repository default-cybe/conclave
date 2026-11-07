/**
 * The sidebar's group headings (Today, Yesterday, a project, a device) read
 * as section labels, not session rows (Sidebar.tsx GroupHeading,
 * docs/design/SPEC.md 5.3): an h3 with a fold button, 600 in full `--fg`
 * against the rows' regular `--fg-2`, no hover fill, never uppercase.
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

  test('reads as a heading: semibold full fg, not the muted row colour, no row hover fill, no uppercase', () => {
    const out = draw(false);
    expect(out).toContain('font-semibold');
    const button = out.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(button.split(' ')).toContain('text-fg');
    expect(button).not.toMatch(/text-fg-[234]\b/);
    expect(out).toContain('text-[13px]');
    expect(draw(false, true)).toContain('text-[14px]');
    expect(out).not.toContain('bg-side-hover');
    expect(out).not.toContain('uppercase');
  });
});
