import { describe, expect, test } from 'bun:test';
import { looksLikeHubUrl } from '../src/features/connect/errors';

describe('looksLikeHubUrl', () => {
  test('a name typed in the address field is not an address', () => {
    expect(looksLikeHubUrl('kaivalya')).toBe(false);
    expect(looksLikeHubUrl(' kaivalya ')).toBe(false);
  });
  test('real addresses pass', () => {
    for (const a of ['hub.example.com', 'https://hub.example.com', '192.168.1.50:7717', 'localhost', 'madx:7717', 'http://madx', '[::1]:7717']) expect(looksLikeHubUrl(a)).toBe(true);
  });
});
