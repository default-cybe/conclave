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
 *
 * Scheduled meetings (11.6):
 *   GET    /api/meetings?view=upcoming|now|past|all&limit=&before=
 *   GET    /api/meetings/folders?q=                   { folders }
 *   GET    /api/meetings/calendar?from=&to=           { events, errors } (31 days at most)
 *   GET    /api/meetings/presets                      { presets }
 *   POST   /api/meetings/:id/arm                      202 Meeting
 *   GET    /api/meetings/:id/prep                     PrepView
 *   POST   /api/meetings/:id/prep                     202 { state: 'queued' }
 *   POST   /api/meetings/:id/prep/cancel              204
 *   PUT    /api/meetings/:id/prep                     PrepView
 *   DELETE /api/meetings/:id/prep/edit                204
 *   PUT    /api/meetings/:id/prep/extra               204
 *
 * After the meeting:
 *   POST   /api/meetings/:id/memory                   Meeting (memoryId set; once)
 *   GET    /api/meetings/:id/context                  { text } what a chat gets
 *   POST   /api/meetings/:id/chat                     Session { to?, sessionId? }
 */
import type { Hono } from 'hono';
import { meetingsOf, type MeetingService } from '@conclave/core/meeting/index.ts';
import { BATCH_BODY_MAX, STEERING_PRESETS, segmentBatchProblem, type AnswerNowInput, type CreateMeetingInput, type MeetingChatInput, type MeetingPatch, type SegmentBatch } from '@conclave/core/meeting/wire.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, qNum, readJson } from './http';
import { accountOf } from './scope';

/** Small bodies everywhere: an agenda is at most 4000 characters. */
const SMALL_BODY = 32 * 1024;
/** A prep edit: at most 60,000 characters, up to 4 bytes each. */
const PREP_BODY = 256 * 1024;
const VIEWS = ['upcoming', 'now', 'past', 'all'] as const;
const DAY = 86_400_000;

export function registerMeetingRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const svc = (): MeetingService => {
    const s = meetingsOf(ctx.engine);
    if (!s) throw new HttpError(501, 'This hub has no meeting mode.');
    return s;
  };

  app.get('/api/meetings', (c) => {
    const limit = Math.min(200, Math.max(1, qNum(c.req.query('limit')) ?? 50));
    const view = c.req.query('view');
    if (view !== undefined && !(VIEWS as readonly string[]).includes(view)) throw new HttpError(400, 'view is upcoming, now, past or all');
    return c.json({ meetings: svc().list(accountOf(c), { projectId: c.req.query('projectId') || undefined, limit, view: view as (typeof VIEWS)[number] | undefined, before: qNum(c.req.query('before')) }) });
  });

  // before /:id, so the id route does not catch them
  app.get('/api/meetings/folders', (c) => c.json({ folders: svc().folders(accountOf(c), c.req.query('q') ?? '') }));

  app.get('/api/meetings/calendar', async (c) => {
    const from = qNum(c.req.query('from')) ?? Date.now();
    const to = qNum(c.req.query('to')) ?? from + 14 * DAY;
    if (!(to > from) || to - from > 31 * DAY) throw new HttpError(400, 'from and to are epoch ms, at most 31 days apart');
    return c.json(await svc().calendar(accountOf(c), { start: from, end: to }));
  });

  app.get('/api/meetings/presets', (c) => c.json({ presets: STEERING_PRESETS }));

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

  app.post('/api/meetings/:id/arm', (c) => c.json(svc().arm(c.req.param('id'), accountOf(c)), 202));

  app.get('/api/meetings/:id/prep', (c) => c.json(svc().prepView(c.req.param('id'), accountOf(c))));

  app.post('/api/meetings/:id/prep', async (c) => {
    const text = await c.req.text();
    if (text.length > SMALL_BODY) throw new HttpError(413, 'Body too large');
    let body: { approve?: unknown } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    return c.json(svc().startPrep(c.req.param('id'), accountOf(c), { approve: body?.approve === true }), 202);
  });

  app.post('/api/meetings/:id/prep/cancel', (c) => {
    svc().cancelPrep(c.req.param('id'), accountOf(c));
    return c.body(null, 204);
  });

  app.put('/api/meetings/:id/prep', async (c) => c.json(svc().editPrep(c.req.param('id'), (await readJson<{ markdown?: unknown }>(c, PREP_BODY)).markdown, accountOf(c))));

  app.delete('/api/meetings/:id/prep/edit', (c) => {
    svc().revertPrep(c.req.param('id'), accountOf(c));
    return c.body(null, 204);
  });

  app.put('/api/meetings/:id/prep/extra', async (c) => {
    svc().setPrepExtra(c.req.param('id'), (await readJson<{ sessionIds?: unknown }>(c, SMALL_BODY)).sessionIds, accountOf(c));
    return c.body(null, 204);
  });

  app.post('/api/meetings/:id/memory', (c) => c.json(svc().saveToMemory(c.req.param('id'), accountOf(c))));

  app.get('/api/meetings/:id/context', (c) => c.json({ text: svc().chatText(c.req.param('id'), accountOf(c)) }));

  app.post('/api/meetings/:id/chat', async (c) => c.json(await svc().toChat(c.req.param('id'), await readJson<MeetingChatInput>(c, SMALL_BODY), accountOf(c))));

  app.delete('/api/meetings/:id', async (c) => {
    await svc().delete(c.req.param('id'), accountOf(c));
    return c.body(null, 204);
  });
}
