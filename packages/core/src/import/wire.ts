/**
 * The device side of chat import (protocol v2: importScan, importRead,
 * readRange). A v2 daemon runs the same readers as the hub on its own disk
 * and sends compact rows, so a 23 MB transcript is never sent whole over
 * the WebSocket. The hub calls these through Machine.importScan and
 * Machine.importRead when the device speaks v2, and runs scanMachine itself
 * for a v1 daemon.
 */
import type { Machine } from '../machine/types';
import type { ConvertedSession } from '../importers/types';
import { ReadContext, scanMachine } from './sources';
import type { FoundSession, ImportReadParams, ImportScanParams, ScanResult } from './types';

export type { ImportReadParams, ImportScanParams, ImportScanWire } from './types';

export const DEVICE_TOOL_CHARS = 50_000;

/** importScan on this machine. */
export function deviceScan(machine: Machine, p: ImportScanParams = {}): Promise<ScanResult> {
  const known = new Map((p.known ?? []).map(([path, size, mtime]) => [path, { size, mtime }]));
  return scanMachine(machine, { sources: p.sources, known, concurrency: p.concurrency });
}

/** Cut long tool results to head and tail, and say how long they were. */
export function clipToolResults(conv: ConvertedSession, max: number): ConvertedSession {
  for (const m of conv.messages) {
    for (let i = 0; i < m.content.length; i++) {
      const b = m.content[i];
      if (b.type !== 'tool_result' || typeof b.content !== 'string' || b.content.length <= max) continue;
      const half = Math.floor(max / 2);
      const n = b.content.length;
      m.content[i] = {
        ...b,
        content: `${b.content.slice(0, half)}\n\n[${n - 2 * half} characters cut on the device; the full output stays in the source file]\n\n${b.content.slice(n - half)}`,
        meta: { ...(b.meta ?? {}), clippedFrom: n },
      };
    }
  }
  return conv;
}

/** importRead on this machine: one session, converted, with long tool results cut. */
export async function deviceRead(machine: Machine, p: ImportReadParams): Promise<ConvertedSession> {
  const st = await machine.stat(p.path);
  if (!st) throw Object.assign(new Error(`${p.path} is not on this device any more`), { code: 'ENOENT' });
  const found: FoundSession = { source: p.source, path: p.path, size: st.size, mtime: Math.round(st.mtimeMs), ...(p.parent ? { parent: p.parent } : {}) };
  const conv = await new ReadContext(machine).read(found);
  return clipToolResults(conv, Math.max(2_000, p.maxToolChars ?? DEVICE_TOOL_CHARS));
}
