import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { EventBus } from '../../src/util/bus';
import { ConfigStore, type ConclaveConfig } from '../../src/config';
import type { Message } from '../../src/types';

export function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function setup(overrides?: Partial<ConclaveConfig>) {
  const home = tempHome();
  const config = new ConfigStore(home.dir, overrides);
  const db = openDb(':memory:');
  const bus = new EventBus();
  const events: string[] = [];
  bus.on((e) => events.push(e.type));
  return { config, db, bus, events, cleanup: () => (db.close(), home.cleanup()) };
}

let seq = 0;
export function msg(role: 'user' | 'assistant', text: string, sessionId = 's1', s?: number): Message {
  const n = s ?? seq++;
  return { id: `m${n}`, sessionId, seq: n, role, kind: 'normal', content: [{ type: 'text', text }], createdAt: Date.now() };
}

/** Tiny deterministic embedding: hashed bag of words. */
export function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (['the', 'a', 'user', 'in', 'is', 'all'].includes(w)) continue;
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % 64] += 1;
      }
      return v;
    }),
  );
}
