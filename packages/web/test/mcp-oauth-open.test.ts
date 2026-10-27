import { describe, expect, test } from 'bun:test';
import { openAuthorize } from '../src/features/extensions/mcp/parts';

function fakeTab() {
  return { opener: {} as unknown, closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
}

describe('openAuthorize', () => {
  test('the sign-in tab loses its opener before it navigates', () => {
    const tab = fakeTab();
    const here = { assigned: '', assign(u: string) { this.assigned = u; } };
    expect(openAuthorize(tab as never, 'https://mcp.notion.com/authorize?x=1', here)).toBe(true);
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://mcp.notion.com/authorize?x=1');
    expect(here.assigned).toBe('');
  });

  test('a non-https address opens nowhere', () => {
    for (const url of ['javascript:alert(1)', 'http://evil.example/', 'data:text/html,x']) {
      const tab = fakeTab();
      const here = { assigned: '', assign(u: string) { this.assigned = u; } };
      expect(openAuthorize(tab as never, url, here)).toBe(false);
      expect(tab.closed).toBe(true);
      expect(tab.location.href).toBe('about:blank');
      expect(openAuthorize(null, url, here)).toBe(false);
      expect(here.assigned).toBe('');
    }
  });

  test('with the popup blocked, only https goes to the same tab', () => {
    const here = { assigned: '', assign(u: string) { this.assigned = u; } };
    expect(openAuthorize(null, 'https://linear.app/oauth/authorize', here)).toBe(true);
    expect(here.assigned).toBe('https://linear.app/oauth/authorize');
  });
});
