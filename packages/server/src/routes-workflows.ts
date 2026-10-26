/**
 * Workflow routes (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17,
 * docs/WORKFLOWS.md): the library, runs and their controls, worktree
 * actions and verdicts on findings. The work is in
 * packages/core/src/workflows; these handlers validate and call it.
 */
import type { Hono } from 'hono';
import type { FindingVerdict, StartWorkflowInput, WorkflowRunStatus, WorktreeAction } from '@conclave/core/client/workflows.ts';
import { workflowsOf } from '@conclave/core/workflows/attached.ts';
import type { WorkflowService } from '@conclave/core/workflows/service.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, optString, qNum, readJson } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf, ownSession } from './scope';

const STATUSES: WorkflowRunStatus[] = ['queued', 'running', 'paused', 'waiting_reset', 'interrupted', 'done', 'failed', 'stopped', 'budget'];
const ACTIONS: WorktreeAction[] = ['diff', 'merge', 'cherry-pick', 'discard'];
const VERDICTS: FindingVerdict[] = ['fixed', 'dismissed', 'ignored'];

function optPositive(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw badRequest(`${name} must be a positive number`);
  return v;
}

/** Validate a POST /api/workflows/runs body. */
export function startInput(body: Record<string, unknown>): StartWorkflowInput {
  const name = optString(body.name, 'name', 512);
  const script = optString(body.script, 'script', 256 * 1024);
  const scriptPath = optString(body.scriptPath, 'scriptPath', 4096);
  const resumeFromRunId = optString(body.resumeFromRunId, 'resumeFromRunId', 512);
  if (!name && !script && !scriptPath && !resumeFromRunId) throw badRequest('name, script, scriptPath or resumeFromRunId is required');
  let budget: StartWorkflowInput['budget'];
  if (body.budget !== undefined && body.budget !== null) {
    if (typeof body.budget !== 'object' || Array.isArray(body.budget)) throw badRequest('budget must be an object with tokens and costUsd');
    const b = body.budget as Record<string, unknown>;
    const tokens = optPositive(b.tokens, 'budget.tokens');
    const costUsd = optPositive(b.costUsd, 'budget.costUsd');
    if (tokens || costUsd) budget = { ...(tokens ? { tokens: Math.floor(tokens) } : {}), ...(costUsd ? { costUsd } : {}) };
  }
  if (body.background !== undefined && typeof body.background !== 'boolean') throw badRequest('background must be true or false');
  return {
    ...(name ? { name } : {}),
    ...(script ? { script } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    ...(body.args !== undefined ? { args: body.args } : {}),
    ...(optString(body.sessionId, 'sessionId', 512) ? { sessionId: body.sessionId as string } : {}),
    ...(optString(body.device, 'device', 512) ? { device: body.device as string } : {}),
    ...(optString(body.cwd, 'cwd', 4096) ? { cwd: body.cwd as string } : {}),
    ...(budget ? { budget } : {}),
    ...(resumeFromRunId ? { resumeFromRunId } : {}),
    ...(body.background ? { background: true } : {}),
  };
}

export function registerWorkflowRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const { engine } = ctx;
  const svc = (): WorkflowService => {
    const s = workflowsOf(engine);
    if (!s) throw new HttpError(501, 'Workflows are not available on this hub.');
    return s;
  };
  const seqOf = (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw badRequest('call number must be a positive integer');
    return n;
  };

  // a session in a query must be the caller's own: it picks the project whose workflows are listed
  const sessionQuery = (c: Parameters<typeof accountOf>[0]): string | undefined => {
    const id = c.req.query('sessionId') || undefined;
    return id ? ownSession(engine, c, id) : undefined;
  };

  app.get('/api/workflows', async (c) => c.json(await svc().library({ sessionId: sessionQuery(c), accountId: accountOf(c) })));

  // runs first, so "runs" never reads as a workflow id
  app.get('/api/workflows/runs', (c) => {
    const status = c.req.query('status');
    if (status && !STATUSES.includes(status as WorkflowRunStatus)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    return c.json(
      svc().runs({
        ...(c.req.query('sessionId') ? { sessionId: sessionQuery(c) } : {}),
        accountId: accountOf(c),
        ...(status ? { status: status as WorkflowRunStatus } : {}),
        ...(c.req.query('name') ? { name: c.req.query('name') } : {}),
        ...(qNum(c.req.query('limit')) ? { limit: qNum(c.req.query('limit')) } : {}),
      }),
    );
  });

  app.post('/api/workflows/runs', async (c) => {
    const input = startInput(await readJson(c));
    if (input.sessionId) ownSession(engine, c, input.sessionId);
    if (input.device && input.device !== 'local' && !engine.devices.get(input.device)) throw new HttpError(409, `device ${input.device} is not connected`);
    const run = await svc().startRun(input, { accountId: accountOf(c) });
    audit(c, 'workflow.start', `${run.name} (${run.id})`);
    return c.json(run, 201);
  });

  app.get('/api/workflows/runs/:id', (c) => c.json(svc().run(c.req.param('id'))));

  app.post('/api/workflows/runs/:id/pause', (c) => c.json(svc().pause(c.req.param('id'))));
  app.post('/api/workflows/runs/:id/resume', async (c) => c.json(await svc().resume(c.req.param('id'))));
  app.post('/api/workflows/runs/:id/stop', (c) => {
    const run = svc().stop(c.req.param('id'));
    audit(c, 'workflow.stop', `${run.name} (${run.id})`);
    return c.json(run);
  });
  app.post('/api/workflows/runs/:id/rerun', async (c) => {
    const body = await readJson<{ fromSeq?: unknown }>(c);
    if (typeof body.fromSeq !== 'number' || !Number.isInteger(body.fromSeq) || body.fromSeq < 1) throw badRequest('fromSeq must be a call number');
    return c.json(await svc().rerun(c.req.param('id'), body.fromSeq));
  });

  app.post('/api/workflows/runs/:id/calls/:seq/skip', (c) => c.json(svc().skip(c.req.param('id'), seqOf(c.req.param('seq')))));

  app.post('/api/workflows/runs/:id/calls/:seq/worktree', async (c) => {
    const body = await readJson<{ action?: unknown }>(c);
    const action = body.action as WorktreeAction;
    if (!ACTIONS.includes(action)) throw badRequest(`action must be one of ${ACTIONS.join(', ')}`);
    const res = await svc().worktree(c.req.param('id'), seqOf(c.req.param('seq')), action);
    if (action !== 'diff') audit(c, `workflow.worktree.${action}`, `${c.req.param('id')} call ${c.req.param('seq')}: ${res.ok ? 'ok' : 'failed'}`);
    return c.json(res);
  });

  app.post('/api/workflows/runs/:id/findings/:findingId', async (c) => {
    const body = await readJson<{ verdict?: unknown; reason?: unknown }>(c);
    const verdict = body.verdict as FindingVerdict;
    if (!VERDICTS.includes(verdict)) throw badRequest(`verdict must be one of ${VERDICTS.join(', ')}`);
    const reason = optString(body.reason, 'reason', 2000);
    return c.json(svc().judgeFinding(c.req.param('id'), c.req.param('findingId'), verdict, reason));
  });

  // a workflow by id; plugin ids (plugin:name) arrive URL-encoded
  app.get('/api/workflows/:id', async (c) => {
    let id: string;
    try {
      // the raw segment, decoded once: Hono's param is decoded already, and decoding it again breaks a name with a %
      id = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/workflows/'.length));
    } catch {
      throw badRequest('the workflow id is not a valid URL-encoded name');
    }
    return c.json(await svc().detail(id, sessionQuery(c)));
  });

  // saved launch presets for one workflow; the owner's phone reruns them
  app.get('/api/workflows/:id/presets', async (c) => c.json(await svc().listPresets(c.req.param('id'), accountOf(c))));

  app.post('/api/workflows/:id/presets', async (c) => {
    const body = await readJson<{ name?: unknown; args?: unknown }>(c);
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name is required');
    if (body.args !== undefined && (typeof body.args !== 'object' || Array.isArray(body.args))) throw badRequest('args must be a JSON object');
    const preset = await svc().savePreset(c.req.param('id'), body.name.trim(), body.args, accountOf(c));
    audit(c, 'workflow.preset.save', `${preset.workflow}: ${preset.name}`);
    return c.json(preset, 201);
  });

  app.delete('/api/workflows/:id/presets/:presetId', async (c) => {
    await svc().deletePreset(c.req.param('id'), c.req.param('presetId'), accountOf(c));
    audit(c, 'workflow.preset.delete', `${c.req.param('id')}: ${c.req.param('presetId')}`);
    return c.body(null, 204);
  });
}
