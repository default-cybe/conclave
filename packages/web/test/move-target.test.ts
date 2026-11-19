/**
 * Where a session move goes (features/chat/FolderChooser.tsx moveTarget):
 * "local" is the hub's own computer, the owner's only. A member's move there
 * got 404 "unknown device local"; in the desktop app it now goes to the
 * member's own computer, else it says why in words.
 *
 *   bun test packages/web/test/move-target.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { MEMBER_NO_HUB, moveTarget } from '../src/features/chat/FolderChooser';

describe('moveTarget', () => {
  test('the owner moves to the hub as asked', () => {
    expect(moveTarget('local', { member: false, here: 'dev_pc' })).toEqual({ device: 'local' });
  });

  test("a member's move to the hub goes to this computer in the desktop app", () => {
    expect(moveTarget('local', { member: true, here: 'dev_pc' })).toEqual({ device: 'dev_pc' });
  });

  test('a member with no computer of this app is told why, nothing is sent', () => {
    expect(moveTarget('local', { member: true })).toEqual({ error: MEMBER_NO_HUB });
  });

  test('a real device id passes through for everyone', () => {
    expect(moveTarget('dev_mac', { member: true, here: 'dev_pc' })).toEqual({ device: 'dev_mac' });
    expect(moveTarget('dev_mac', { member: false })).toEqual({ device: 'dev_mac' });
  });
});
