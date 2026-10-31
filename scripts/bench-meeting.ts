/**
 * Meeting mode latency benchmark (docs/design/MEETING-MODE.md 4.1, 9.2): the
 * hub's own part, from a "them" question POSTed to /api/meetings/:id/segments
 * to the first message.delta of its answer on /api/ws, with a fake provider
 * that answers at once. Server and WS client run in this process.
 *
 *   bun scripts/bench-meeting.ts [questions=60]
 *
 * Fails (exit 1) when p95 is over 25 ms. Run it on the hub when nothing else runs.
 *
 * shortcut: synthetic questions, not the recorded standup.jsonl replay of 9.2;
 * upgrade when a real meeting transcript is recorded.
 */
import { startTestEngine } from '../packages/core/test/engine/harness';
import { meetingsOf } from '../packages/core/src/meeting/index';
import { startServer } from '../packages/server/src/app';

const N = Number(process.argv[2] ?? 60);
const TOKEN = 'bench-owner-token-0123456789abcdef';
/** The 6-a-minute rate window (4.3) caps each meeting; a fresh meeting every 5 questions. */
const PER_MEETING = 5;

const t = await startTestEngine({
  script: [[{ text: 'unused' }]],
  chore: (b) => (JSON.stringify(b.system ?? '').includes('You write the notes') ? [{ text: '{"summary":"","decisions":[],"actionItems":[],"openQuestions":[]}' }] : [{ text: 'Say this:\n- It ships Friday.\nSource: your notes' }]),
});
t.engine.config.update({ server: { ...t.engine.config.get().server, token: TOKEN } });
const hub = startServer(t.engine, { host: '127.0.0.1', port: 0 });
const svc = meetingsOf(t.engine)!;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${hub.url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as any };
};

// frames with their arrival time
const frames: Array<{ at: number; f: any }> = [];
const ws = new WebSocket(`${hub.url.replace(/^http/, 'ws')}/api/ws?token=${TOKEN}`);
ws.onmessage = (m) => frames.push({ at: performance.now(), f: JSON.parse(String(m.data)) });
await new Promise((r) => (ws.onopen = r));

const waitFor = async (pred: (f: any) => boolean, from: number, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = from; i < frames.length; i++) if (pred(frames[i].f)) return frames[i];
    await Bun.sleep(1);
  }
  throw new Error('timed out');
};

const total: number[] = [];
const ack: number[] = [];
let meeting: { id: string } | undefined;
let seq = 0;
for (let q = 0; q < N; q++) {
  if (q % PER_MEETING === 0) {
    if (meeting) {
      await call('POST', `/api/meetings/${meeting.id}/end`);
      await svc.settled();
    }
    meeting = (await call('POST', '/api/meetings', { cwd: t.cwd, title: `Bench ${q}` })).body;
    while (svc.store.get(meeting!.id)?.status !== 'ready') await Bun.sleep(5);
    seq = 0;
  }
  const from = frames.length;
  const t0 = performance.now();
  const r = await call('POST', `/api/meetings/${meeting!.id}/segments`, { clientId: 'bench', t0: Date.now(), segments: [{ seq, channel: 'them', startMs: seq * 5000, endMs: seq * 5000 + 2000, text: `What is the status of item ${q}?`, final: true }] });
  ack.push(performance.now() - t0);
  if (r.status !== 200) throw new Error(`segments ${r.status} ${JSON.stringify(r.body)}`);
  seq++;
  const a = await waitFor((f) => f.type === 'meeting.answer' && f.meetingId === meeting!.id && f.answer.state === 'streaming', from);
  const d = await waitFor((f) => f.type === 'message.delta' && f.messageId === a.f.answer.messageId, from);
  total.push(d.at - t0);
  await Bun.sleep(30); // let the answer finish so the next one does not cancel it
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms`;
console.log(`questions: ${N}`);
console.log(`POST to ack:                ${fmt(ack)}`);
console.log(`POST to first delta on WS:  ${fmt(total)}`);
const answers = svc.store.list('owner', { limit: 500 }).flatMap((m) => svc.store.answers(m.id));
console.log(`answers: ${answers.length}, cancelled ${answers.filter((a) => a.state === 'cancelled').length}, speculative ${answers.filter((a) => a.trigger === 'speculative').length}`);

ws.close();
if (meeting) await call('POST', `/api/meetings/${meeting.id}/end`);
await svc.settled();
await hub.stop();
await t.close();
const p95 = pct(total, 95);
if (p95 > 25) {
  console.error(`FAIL: p95 ${p95.toFixed(1)} ms is over the 25 ms budget`);
  process.exit(1);
}
console.log('PASS: p50 under 10 ms and p95 under 25 ms is the budget');
process.exit(pct(total, 50) > 10 ? 1 : 0);
