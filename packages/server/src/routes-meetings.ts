/**
 * Meeting mode routes (docs/design/MEETING-MODE.md 3.1) over MeetingService
 * (core/src/meeting/index.ts). The account always comes from the token; every
 * :id route is own({ id: 'meeting' }) in route-policy.ts, and the service
 * checks the account again, so another account's meeting reads as unknown.
 *
 *   GET    /api/meetings                              { meetings }
 *   POST   /api/meetings                              201 Meeting
 *   GET    /api/meetings/:id                          MeetingDetail
 *   PATCH  /api/meetings/:id                          Meeting
 *   POST   /api/meetings/:id/segments                 SegmentAck (the desktop app)
 *   POST   /api/meetings/:id/answer                   202 { answerId, messageId }
 *   POST   /api/meetings/:id/answers/:answerId/cancel 204
 *   POST   /api/meetings/:id/end                      202 Meeting
 *   GET    /api/meetings/:id/notes                    MeetingNotes
 *   DELETE /api/meetings/:id                          204
 */
import type { Hono } from 'hono';
import { meetingsOf, type MeetingService } from '@conclave/core/meeting/index.ts';
import { BATCH_BODY_MAX, segmentBatchProblem, type AnswerNowInput, type CreateMeetingInput, type MeetingPatch, type SegmentBatch } from '@conclave/core/meeting/wire.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, qNum, readJson } from './http';
import { accountOf } from './scope';

/** Small bodies everywhere: an agenda is at most 4000 characters. */
const SMALL_BODY = 16 * 1024;

export function registerMeetingRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const svc = (): MeetingService => {
    const s = meetingsOf(ctx.engine);
    if (!s) throw new HttpError(501, 'This hub has no meeting mode.');
    return s;
  };

  app.get('/api/meetings', (c) => {
    const limit = Math.min(200, Math.max(1, qNum(c.req.query('limit')) ?? 50));
    return c.json({ meetings: svc().list(accountOf(c), { projectId: c.req.query('projectId') || undefined, limit }) });
  });

  app.post('/api/meetings', async (c) => {
    const body = await readJson<CreateMeetingInput>(c, SMALL_BODY);
    for (const k of ['sessionId', 'projectId', 'device', 'cwd'] as const) {
      if (body[k] !== undefined && typeof body[k] !== 'string') throw new HttpError(400, `${k} must be a string`);
    }
    return c.json(await svc().create(body, accountOf(c)), 201);
  });

  app.get('/api/meetings/:id', (c) => c.json(svc().detail(c.req.param('id'), accountOf(c), { before: qNum(c.req.query('before')) })));

  app.patch('/api/meetings/:id', async (c) => c.json(svc().patch(c.req.param('id'), await readJson<MeetingPatch>(c, SMALL_BODY), accountOf(c))));

  app.post('/api/meetings/:id/segments', async (c) => {
    const body = await readJson<SegmentBatch>(c, BATCH_BODY_MAX);
    const problem = segmentBatchProblem(body);
    if (problem) throw new HttpError(400, problem);
    return c.json(svc().ingest(c.req.param('id'), body, accountOf(c)));
  });

  app.post('/api/meetings/:id/answer', async (c) => {
    const body = await readJson<AnswerNowInput>(c, SMALL_BODY);
    if (body.reason !== undefined && body.reason !== 'hotkey' && body.reason !== 'button') throw new HttpError(400, 'reason is hotkey or button');
    return c.json(svc().answerNow(c.req.param('id'), body, accountOf(c)), 202);
  });

  app.post('/api/meetings/:id/answers/:answerId/cancel', (c) => {
    svc().cancelAnswer(c.req.param('id'), c.req.param('answerId'), accountOf(c));
    return c.body(null, 204);
  });

  app.post('/api/meetings/:id/end', (c) => c.json(svc().end(c.req.param('id'), accountOf(c)), 202));

  app.get('/api/meetings/:id/notes', (c) => c.json(svc().notes(c.req.param('id'), accountOf(c))));

  app.delete('/api/meetings/:id', async (c) => {
    await svc().delete(c.req.param('id'), accountOf(c));
    return c.body(null, 204);
  });
}
