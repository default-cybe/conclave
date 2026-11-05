/**
 * A long session on a phone opens with its latest pieces only, as on
 * desktop (window.ts): mounting 2,000 messages at once took about a minute
 * at 4x CPU in the mock. Older pieces mount as you scroll up and in idle time.
 *
 *   bun test packages/web/test/phone-transcript-window.test.tsx
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Session } from '@conclave/core/types';
import { PhoneTranscript } from '../src/features/chat/PhoneTranscript';
import { WINDOW } from '../src/features/chat/window';
import { useHub } from '../src/store/store';

const session = { id: 'sp', status: 'idle', model: 'mock/model', agent: 'assistant' } as Session;
const msg = (i: number, role: 'user' | 'assistant'): Message => ({ id: `m${i}`, sessionId: 'sp', seq: i, role, kind: 'normal', content: [{ type: 'text', text: `${role} ${i}` }], createdAt: i }) as Message;

// rows read location (links in a turn); no hash here
const g = globalThis as { location?: unknown };
const had = 'location' in g;
g.location ??= new URL('http://hub.test/s/sp');
afterAll(() => {
  if (!had) delete g.location;
});

describe('phone transcript window', () => {
  test('a long session mounts only its latest pieces, newest last', () => {
    const initial = useHub.getInitialState();
    initial.messages = { sp: Array.from({ length: 400 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user')) };
    initial.messagesLoaded = { sp: true };
    const html = renderToStaticMarkup(<PhoneTranscript session={session} />);
    const units = html.match(/data-unit="/g) ?? [];
    expect(units.length).toBe(WINDOW.first);
    expect(html).toContain('assistant 399');
    expect(html).not.toContain('user 0<');
    initial.messages = {};
    initial.messagesLoaded = {};
  });

  test('a short session mounts all of it', () => {
    const initial = useHub.getInitialState();
    initial.messages = { sp: [msg(0, 'user'), msg(1, 'assistant')] };
    initial.messagesLoaded = { sp: true };
    const html = renderToStaticMarkup(<PhoneTranscript session={session} />);
    expect(html.match(/data-unit="/g)?.length).toBe(2);
    initial.messages = {};
    initial.messagesLoaded = {};
  });
});
