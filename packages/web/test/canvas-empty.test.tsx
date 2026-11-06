/**
 * The empty canvas (features/canvas/EmptyCanvas.tsx): the hint and the
 * Describe it box on a blank file; once the words are sent the box folds to a
 * small Building chip at the top, with no wait for the first block.
 *
 *   bun test packages/web/test/canvas-empty.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyCanvas } from '../src/features/canvas/EmptyCanvas';

const html = (p: { empty: boolean; building: boolean; blocks: number }) => renderToStaticMarkup(<EmptyCanvas {...p} onDescribe={() => {}} phone={false} />);

describe('empty canvas', () => {
  test('a blank file shows the hint and the Describe it box', () => {
    const h = html({ empty: true, building: false, blocks: 0 });
    expect(h).toContain('Double-click or drag a block');
    expect(h).toContain('id="cv-describe"');
    expect(h).not.toContain('Building');
  });
  test('sent, with no block yet: only the Building chip, the box is gone', () => {
    const h = html({ empty: true, building: true, blocks: 0 });
    expect(h).toContain('Building…');
    expect(h).toContain('role="status"');
    expect(h).not.toContain('cv-describe');
    expect(h).not.toContain('Double-click');
  });
  test('the chip counts the blocks as they land; a file with blocks and no build shows nothing', () => {
    expect(html({ empty: false, building: true, blocks: 2 })).toContain('Building… 2 blocks so far');
    expect(html({ empty: false, building: false, blocks: 2 })).toBe('');
  });
});
