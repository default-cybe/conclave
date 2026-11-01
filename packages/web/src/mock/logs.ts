/**
 * Mock routes for Settings > Logs (docs/DESIGN.md 33): the files' size and
 * errors, the debug switch, the lines the app sends about itself, and a
 * download the demo cannot make.
 */
import type { ClientLogBatch, LogsStatus } from '@conclave/core/client';
import type { MockCtx } from './index';

const DAY = 86_400_000;

export function registerLogs(ctx: MockCtx) {
  const { on, fail, FRESH } = ctx;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const status: LogsStatus = FRESH
    ? { dir: '/home/sam/.conclave/logs', files: 1, bytes: 18_400, oldest: day(Date.now()), newest: day(Date.now()), keepDays: 28, maxMB: 500, errorsToday: 0, errorsWeek: 0, warningsToday: 0 }
    : { dir: '/home/sam/.conclave/logs', files: 12, bytes: 4_812_000, oldest: day(Date.now() - 11 * DAY), newest: day(Date.now()), keepDays: 28, maxMB: 500, errorsToday: 2, errorsWeek: 9, warningsToday: 5 };
  let received = 0;

  on('GET', '/api/logs', () => ({ ...status }));
  on('PUT', '/api/logs/debug', ({ body }: { body?: { hours?: number } }) => {
    const hours = body?.hours;
    if (typeof hours !== 'number' || hours < 0 || hours > 168) fail(400, 'hours must be a number from 0 to 168');
    if (hours) status.debugUntil = Date.now() + hours * 3_600_000;
    else delete status.debugUntil;
    return { ...status };
  });
  on('POST', '/api/logs/client', ({ body }: { body?: ClientLogBatch }) => {
    const n = Math.min(body?.events?.length ?? 0, 50);
    received += n;
    return { accepted: n, dropped: (body?.events?.length ?? 0) - n };
  });
  on('GET', '/api/logs/tail', () => ({ lines: [], cursor: `${day(Date.now())}:${received}` }));
  on('GET', '/api/logs/errors', () => ({ days: 7, from: day(Date.now() - 6 * DAY), to: day(Date.now()), errors: status.errorsWeek, warnings: status.warningsToday, byComponent: [], top: [] }));
  on('GET', '/api/logs/export', () => fail(501, 'The demo has no log files to download.'));
}
