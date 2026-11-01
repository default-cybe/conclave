import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Session } from '@conclave/core/types';
import { TryNextModel } from '../src/features/chat/TryNextModel';
import { ErrorBody } from '../src/features/chat/Notices';
import { MessageList } from '../src/features/chat/MessageList';
import { PhoneTranscript } from '../src/features/chat/PhoneTranscript';
import { useHub } from '../src/store/store';

const notice = { id: 'error1', sessionId: 's1', kind: 'notice', role: 'system', content: [], meta: { type: 'provider_error', canRetry: true } } as unknown as Message;
const session = { id: 's1', status: 'error', model: 'mock/model' } as Session;
const render = (s = session, m = notice) => renderToStaticMarkup(<TryNextModel session={s} message={m} />);

describe('provider retry action', () => {
  test('switch and incidental notices preserve safe action and never restore prompt replay, including expiry', () => {
    const initial = useHub.getInitialState();
    for (const type of ['handoff', 'info']) {
      initial.messages = { s1: [notice, { ...notice, id: 'later', meta: { type } }] };
      expect(render()).toContain('Retry with another model');
      const error = renderToStaticMarkup(<ErrorBody session={session} lastPrompt="repeat side effect" />);
      expect(error).not.toContain('>Retry<');
      expect(error).toContain('Switch model');
    }
    const expired = { ...notice, meta: { ...notice.meta, canRetry: false, retryExpired: true } };
    initial.messages = { s1: [expired, { ...notice, id: 'later', meta: { type: 'handoff' } }] };
    const error = renderToStaticMarkup(<ErrorBody session={session} lastPrompt="repeat side effect" />);
    expect(error).not.toContain('>Retry<');
    expect(error).toContain('expired when the hub restarted');
    expect(render(session, expired)).toBe('');
    initial.messages = {};
  });

  test('a failed chat shows the failed pet beside its reason, on desktop and on a phone', () => {
    const initial = useHub.getInitialState();
    const failed = { ...session, id: 's2', error: 'The provider is overloaded' } as Session;
    initial.messages = { s2: [] };
    initial.messagesLoaded = { s2: true };
    for (const List of [MessageList, PhoneTranscript]) {
      const html = renderToStaticMarkup(<List session={failed} />);
      expect(html).toMatch(/role="alert"><p[^>]*><svg[^>]*class="cv-pet[^"]*" data-state="failed"/);
      expect(html).toContain('The provider is overloaded.');
    }
    initial.messages = {};
    initial.messagesLoaded = {};
  });

  test('offers alternate model only on latest provider failure while idle', () => {
    const initial = useHub.getInitialState();
    initial.messages = { s1: [notice] };
    expect(render()).toContain('Retry with another model');
    expect(render({ ...session, status: 'running' })).toBe('');
    expect(render({ ...session, status: 'waiting_approval' })).toBe('');
    expect(render(session, { ...notice, meta: { type: 'error' } })).toBe('');
    expect(render(session, { ...notice, meta: { type: 'provider_error', canRetry: false } })).toBe('');
    initial.messages = { s1: [notice, { ...notice, id: 'newer', kind: 'normal' }] };
    expect(render()).toBe('');
    initial.messages = {};
  });
});
