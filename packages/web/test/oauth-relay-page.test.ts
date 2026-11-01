/**
 * The Google sign-in relay page on the project site (site/oauth/google/):
 * which return addresses it accepts from the state, and where Continue goes.
 * The state comes from the hub's own relayState, so the two sides are tested
 * against each other.
 */
import { describe, expect, test } from 'bun:test';
import { CALLBACK_PATH, checkReturn, relayTarget, returnUrl } from '../../../site/oauth/google/relay.js';
import { GOOGLE_CALLBACK, relayCallback, relayState } from '@conclave/core/pim/oauth-flows.ts';

const ID = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0';
/** A state as the hub writes it for this origin. */
const stateFor = (origin: string) => relayState(ID, relayCallback(origin)!);
/** A state carrying any text as the return address, as a forged one would. */
const forged = (text: string) => `${ID}.${Buffer.from(text, 'utf8').toString('base64url')}`;

describe('relay page', () => {
  test('the page and the hub agree on the callback path', () => {
    expect(CALLBACK_PATH).toBe(GOOGLE_CALLBACK);
  });

  test('a code goes back to the hub the state names, with the state, and nothing else', () => {
    const state = stateFor('http://192.168.1.20:7777');
    const t = relayTarget(`?state=${encodeURIComponent(state)}&code=${encodeURIComponent('4/0Ab_x-y')}&scope=email%20openid&authuser=0&prompt=consent`);
    expect(t).toEqual({ host: '192.168.1.20:7777', origin: 'http://192.168.1.20:7777', href: `http://192.168.1.20:7777/api/pim/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent('4/0Ab_x-y')}` });
    const back = new URL(t.href);
    expect(Object.fromEntries(back.searchParams)).toEqual({ state, code: '4/0Ab_x-y' });
    expect(relayTarget(`?code=x&state=${stateFor('https://hub.example.ts.net')}`).host).toBe('hub.example.ts.net');
    expect(relayTarget(`?code=x&state=${stateFor('http://[::1]:7777')}`).host).toBe('[::1]:7777');
  });

  test('Google\'s error goes back too, so the hub can say what happened', () => {
    const state = stateFor('http://hub.lan:7777');
    const t = relayTarget(`?error=access_denied&state=${state}`);
    expect(t).toMatchObject({ host: 'hub.lan:7777', error: 'access_denied' });
    expect(Object.fromEntries(new URL(t.href).searchParams)).toEqual({ state, error: 'access_denied' });
  });

  test('a return address that is not exactly an http or https origin and the callback path is refused', () => {
    expect(checkReturn(`http://hub.lan:7777${CALLBACK_PATH}`)?.host).toBe('hub.lan:7777');
    for (const bad of [
      'http://hub.lan:7777/api/pim/oauth/google/other',
      'http://hub.lan:7777/',
      `http://hub.lan:7777${CALLBACK_PATH}/more`,
      `http://hub.lan:7777${CALLBACK_PATH}?next=https://evil.example`,
      `http://hub.lan:7777${CALLBACK_PATH}#x`,
      'http://hub.lan:7777/api/pim/oauth/google/../google/callback',
      `javascript:alert(1)//${CALLBACK_PATH}`,
      `JavaScript:alert(document.domain)//x${CALLBACK_PATH}`,
      `data:text/html,<script>alert(1)</script>${CALLBACK_PATH}`,
      `ftp://hub.lan${CALLBACK_PATH}`,
      `file:///etc${CALLBACK_PATH}`,
      `http://user:pw@hub.lan:7777${CALLBACK_PATH}`,
      `http://user@evil.example${CALLBACK_PATH}`,
      `http://hub.lan:7777@evil.example${CALLBACK_PATH}`,
      `//evil.example${CALLBACK_PATH}`,
      `http:\\\\evil.example${CALLBACK_PATH}`,
      ` http://hub.lan${CALLBACK_PATH}`,
      `http://hub.lan${CALLBACK_PATH} `,
      `http://hub .lan${CALLBACK_PATH}`,
      `http://hüb.lan${CALLBACK_PATH}`,
      `HTTP://hub.lan${CALLBACK_PATH}`,
      `http://hub.lan:80${CALLBACK_PATH}`,
      '',
    ]) {
      expect(checkReturn(bad)).toBeNull();
      expect(returnUrl(forged(bad))).toBeNull();
      expect(relayTarget(`?code=x&state=${forged(bad)}`)).toEqual({ why: 'address' });
    }
  });

  test('a state or query that is not one the hub wrote does nothing', () => {
    const good = stateFor('http://hub.lan:7777');
    for (const q of ['', '?code=x', `?state=${good}`, '?state=nodot&code=x', `?state=short.${good.split('.')[1]}&code=x`, `?state=${ID}.&code=x`, `?state=${ID}.a.b&code=x`, `?state=${ID}.%21%21&code=x`, `?state=${ID}.a&code=x`]) {
      expect('href' in relayTarget(q)).toBe(false);
    }
    expect(relayTarget(`?state=${good}&code=${'x'.repeat(3000)}`)).toEqual({ why: 'missing' });
  });
});
