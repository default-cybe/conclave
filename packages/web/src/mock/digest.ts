/**
 * Mock routes. The daily digest switch in Settings, Memory
 * (core/memory/digest.ts): GET and PUT /api/memory/digest. On adds the
 * routine to the routine list, off pauses it. Off on every mock hub, as on a
 * fresh real one.
 */
import type { DigestSettingsDto } from '@conclave/core/client';
import { ROUTINE_SUGGESTIONS } from '@conclave/core/scheduler/suggestions';
import type { MockCtx } from './index';

export function registerDigest(ctx: MockCtx) {
  const { on, db } = ctx;
  let time = '02:30';
  const routine = () => [...db.routines.values()].find((r) => r.builtin === 'daily-digest');
  const schedule = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return `${m} ${h} * * *`;
  };
  const dto = (): DigestSettingsDto => {
    const r = routine();
    return {
      enabled: !!r?.enabled,
      time,
      timezone: 'Europe/Berlin',
      schedule: r?.schedule ?? schedule(time),
      ...(r ? { routineId: r.id } : {}),
      writes: !ctx.FRESH,
    };
  };

  on('GET', '/api/memory/digest', () => dto());

  on('PUT', '/api/memory/digest', async ({ body }) => {
    if (body?.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) ctx.fail(400, 'time must be HH:MM, such as 02:30.');
    await ctx.sleep(200);
    if (typeof body?.time === 'string') time = body.time;
    let r = routine();
    if (!r && body?.enabled === true) {
      const s = ROUTINE_SUGGESTIONS.find((x) => x.id === 'daily-digest')!;
      r = { id: ctx.uid('r'), name: s.name, prompt: s.prompt, builtin: 'daily-digest', suggestion: s.id, device: 'local', agent: 'assistant', mode: 'agent', sessionPolicy: 'new', notify: 'on_error', enabled: true, schedule: schedule(time), timezone: 'Europe/Berlin', createdAt: Date.now(), updatedAt: Date.now() };
    } else if (r) {
      r = { ...r, ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}), schedule: schedule(time), updatedAt: Date.now() };
    }
    if (r) {
      db.routines.set(r.id, r);
      ctx.emit({ type: 'routine.updated', routine: r });
    }
    return dto();
  });
}
