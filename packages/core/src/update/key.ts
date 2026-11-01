/// <reference path="./text.d.ts" />
/**
 * The update key every updater trusts: update-key.pub next to this file,
 * embedded in the build (the Rust daemon, the desktop app and the Android app
 * read the same file at build time). While it is the placeholder, updaters
 * install nothing and say so. Tests pass a key of their own to the functions
 * that check signatures; nothing reads a key from the environment.
 */
import keyText from './update-key.pub' with { type: 'text' };
import { parsePublicKey, type MinisignKey } from './minisign';

/** The key line of an update-key.pub text: the last line that is not empty or a # comment. */
export function keyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.at(-1) ?? '';
}

export type KeyState = { ok: true; key: MinisignKey } | { ok: false; why: string };

export const NO_KEY = 'This build has no update key yet, so it installs no updates. Update by hand this time.';

/** The key in `text`, or why there is none. */
export function readUpdateKey(text: string): KeyState {
  const line = keyLine(text);
  if (!line || /^placeholder$/i.test(line)) return { ok: false, why: NO_KEY };
  try {
    return { ok: true, key: parsePublicKey(line) };
  } catch (err) {
    return { ok: false, why: `This build's update key is broken (${(err as Error).message}). Update by hand this time.` };
  }
}

/** The key line in the form Tauri's config wants (plugins.updater.pubkey): base64 of a whole key file. */
export function tauriPubkey(line: string): string {
  const decoded = Buffer.from(line, 'base64').toString('utf8');
  if (/^untrusted comment:/i.test(decoded.trim())) return line;
  return Buffer.from(`untrusted comment: minisign public key\n${line}\n`).toString('base64');
}

let embedded: KeyState | undefined;

/** The key built into this program. */
export function updateKey(): KeyState {
  embedded ??= readUpdateKey(keyText);
  return embedded;
}

export const UPDATE_KEY_TEXT: string = keyText;
