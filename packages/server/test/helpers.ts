import { startServer, type RunningServer, type StartOptions } from '../src/app';
import { createFakeEngine, type FakeEngine } from './fake-engine';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';

export const OWNER = 'owner-token-0123456789abcdef';

// server tests never reach the network: the Discover catalog serves shipped data only
process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';

export interface TestHub {
  engine: FakeEngine;
  running: RunningServer;
  url: string;
  /** fetch with the owner token (or the given token, or none with null). */
  api(path: string, init?: RequestInit & { token?: string | null; json?: unknown }): Promise<Response>;
  stop(): Promise<void>;
}

export function startHub(opts: StartOptions = {}, config: Partial<ConclaveConfig> = {}): TestHub {
  const engine = createFakeEngine(config);
  const running = startServer(engine, { host: '127.0.0.1', port: 0, ...opts });
  const url = running.url;
  return {
    engine,
    running,
    url,
    api(path, init = {}) {
      const headers = new Headers(init.headers);
      const token = init.token === undefined ? OWNER : init.token;
      if (token) headers.set('authorization', `Bearer ${token}`);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      return fetch(url + path, { ...init, headers, body });
    },
    async stop() {
      await running.stop();
      engine.cleanup();
    },
  };
}

/** Open a WebSocket and collect parsed frames. */
export async function openWs(url: string): Promise<{ ws: WebSocket; frames: any[]; next(pred?: (f: any) => boolean, ms?: number): Promise<any>; close(): void }> {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  let cursor = 0;
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = (e) => reject(new Error(`ws closed ${e.code}`));
  });
  return {
    ws,
    frames,
    next(pred = () => true, ms = 2000) {
      // return the first frame after the cursor that matches, or wait for one
      for (let i = cursor; i < frames.length; i++) {
        if (pred(frames[i])) {
          cursor = i + 1;
          return Promise.resolve(frames[i]);
        }
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(t);
            cursor = frames.indexOf(f) + 1;
            resolve(f);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}
