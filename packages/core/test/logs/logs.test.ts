import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigStore } from '../../src/config';
import { EventBus } from '../../src/util/bus';
import { currentLogTap, logger, setLogTap } from '../../src/util/log';
import { HubLogs, LogSink, LogReader, foldMessage, installCrashLogging, logTurn, CLIENT_BATCH_MAX, CLIENT_PER_MINUTE, MEMBER_PER_HOUR, listLogFiles, dayOf } from '../../src/logs';
import { exportConfig, logsExport } from '../../src/logs/export';
import { LogRing, daemonLogTail } from '../../src/logs/ring';
import { readZip, zipStream } from '../../src/logs/zip';
import type { LogLine } from '../../src/client/logs';

const DAY = 86_400_000;
/** A fake key the secrets filter knows. It must never reach a file. */
const FAKE_KEY = 'sk-ant-api03-PLANTEDfakeKEY0123456789abcdefABCDEF';
const FAKE_GH = 'ghp_PLANTEDghTOKENabcdefghijklmnopqrstuvwxyz0123';
const MESSAGE_TEXT = 'PLANTED MESSAGE TEXT that must never be logged';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'conclave-logs-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  setLogTap(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readLines(dir: string): LogLine[] {
  return listLogFiles(dir).flatMap((f) =>
    readFileSync(f.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine),
  );
}

function allText(dir: string): string {
  return listLogFiles(dir)
    .map((f) => readFileSync(f.path, 'utf8'))
    .join('');
}

class Clock {
  constructor(public t = Date.UTC(2026, 9, 21, 10, 0, 0)) {}
  now = () => this.t;
}

describe('log sink', () => {
  test('one JSON line per event with time, level, component, message and fields, in hub-YYYY-MM-DD.jsonl', () => {
    const dir = tmp();
    const clock = new Clock();
    const sink = new LogSink({ dir, now: clock.now });
    expect(sink.write('info', 'session', 'turn', { sessionId: 'ses_1', durationMs: 1200, ok: true })).toBe(true);
    sink.close();
    expect(readdirSync(dir)).toEqual(['hub-2026-10-21.jsonl']);
    const [line] = readLines(dir);
    expect(line).toEqual({ time: '2026-10-21T10:00:00.000Z', level: 'info', component: 'session', msg: 'turn', fields: { sessionId: 'ses_1', durationMs: 1200, ok: true } });
  });

  test('a new day starts a new file', () => {
    const dir = tmp();
    const clock = new Clock();
    const sink = new LogSink({ dir, now: clock.now });
    sink.write('info', 'hub', 'one');
    clock.t += DAY;
    sink.write('info', 'hub', 'two');
    sink.close();
    expect(readdirSync(dir).sort()).toEqual(['hub-2026-10-21.jsonl', 'hub-2026-10-22.jsonl']);
  });

  test('retention by day: files older than keepDays go when a day starts', () => {
    const dir = tmp();
    const clock = new Clock();
    for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `hub-${dayOf(clock.t - i * DAY)}.jsonl`), '{"x":1}\n');
    writeFileSync(join(dir, 'daemon.log'), 'not ours\n');
    const sink = new LogSink({ dir, now: clock.now, keepDays: () => 3 });
    sink.write('info', 'hub', 'today');
    sink.close();
    // today and the two days before it; other files are left alone
    expect(readdirSync(dir).sort()).toEqual(['daemon.log', 'hub-2026-10-19.jsonl', 'hub-2026-10-20.jsonl', 'hub-2026-10-21.jsonl']);
  });

  test('retention by size: the oldest days go first, never today', () => {
    const dir = tmp();
    const clock = new Clock();
    const big = 'x'.repeat(40 * 1024) + '\n';
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `hub-${dayOf(clock.t - i * DAY)}.jsonl`), big);
    // 100 KB cap: four 40 KB days do not fit
    const sink = new LogSink({ dir, now: clock.now, maxMB: () => 100 / 1024 });
    sink.write('info', 'hub', 'today');
    sink.close();
    expect(readdirSync(dir).sort()).toEqual(['hub-2026-10-19.jsonl', 'hub-2026-10-20.jsonl', 'hub-2026-10-21.jsonl']);
  });

  test("past the cap with only today's file, info goes and warnings still go, with one line saying so", () => {
    const dir = tmp();
    const clock = new Clock();
    const sink = new LogSink({ dir, now: clock.now, maxMB: () => 4 / 1024 });
    const pad = 'p'.repeat(300);
    let n = 0;
    while (sink.write('info', 'hub', `line ${n++}`, { pad }) && n < 1000);
    expect(n).toBeLessThan(1000);
    expect(sink.write('info', 'hub', 'dropped')).toBe(false);
    expect(sink.write('warn', 'hub', 'still kept')).toBe(true);
    sink.close();
    const lines = readLines(dir);
    expect(lines.some((l) => l.component === 'logs' && l.msg.startsWith('size cap reached'))).toBe(true);
    expect(lines.some((l) => l.msg === 'still kept')).toBe(true);
    expect(lines.some((l) => l.msg === 'dropped')).toBe(false);
    // the next day says how many were dropped
    clock.t += DAY;
    const next = new LogSink({ dir, now: clock.now, maxMB: () => 4 / 1024 });
    // a fresh sink knows nothing dropped; the same sink would say so
    next.close();
    expect(listLogFiles(dir).reduce((a, f) => a + f.bytes, 0)).toBeLessThan(4 * 1024 * 1.1 + 600);
  });

  test("a member's app lines never push the owner's older days out, and keep to their share", () => {
    const dir = tmp();
    const clock = new Clock();
    // four of the owner's older days, 96 KB of a 100 KB cap
    const day = 'x'.repeat(24 * 1024 - 1) + '\n';
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `hub-${dayOf(clock.t - i * DAY)}.jsonl`), day);
    const sink = new LogSink({ dir, now: clock.now, maxMB: () => 100 / 1024, keepDays: () => 7 });
    const app = { id: 'cl_bob', app: 'web', account: 'acc_bob' };
    let kept = 0;
    // warnings and errors too: a member's line gets no room past the cap
    for (let i = 0; i < 400; i++) if (sink.write(i % 2 ? 'error' : 'warn', 'client', 'request.failed', { i, pad: 'p'.repeat(200) }, app)) kept++;
    expect(kept).toBeGreaterThan(0);
    expect(listLogFiles(dir).map((f) => f.day)).toEqual([4, 3, 2, 1].map((i) => dayOf(clock.t - i * DAY)).concat(dayOf(clock.t)));
    const today = readFileSync(join(dir, `hub-${dayOf(clock.t)}.jsonl`), 'utf8');
    expect(Buffer.byteLength(today)).toBeLessThanOrEqual(sink.memberDayBytes());
    // the owner's own lines still make room as before: the oldest day goes for them, never for bob
    for (let i = 0; i < 20; i++) sink.write('info', 'hub', `owner ${i}`, { pad: 'p'.repeat(300) });
    expect(listLogFiles(dir).length).toBe(4);
    // the next day says how many of the member lines were dropped
    clock.t += DAY;
    sink.write('info', 'hub', 'new day');
    sink.close();
    expect(readFileSync(join(dir, `hub-${dayOf(clock.t)}.jsonl`), 'utf8')).toContain("members' app lines dropped at their share");
  });

  test('the same sink says the next day how many lines the cap dropped', () => {
    const dir = tmp();
    const clock = new Clock();
    const sink = new LogSink({ dir, now: clock.now, maxMB: () => 2 / 1024 });
    for (let i = 0; i < 50; i++) sink.write('info', 'hub', `line ${i}`, { pad: 'p'.repeat(200) });
    clock.t += DAY;
    sink.write('info', 'hub', 'new day');
    sink.close();
    const today = readFileSync(join(dir, `hub-${dayOf(clock.t)}.jsonl`), 'utf8');
    expect(today).toContain('lines dropped at the size cap');
  });

  test('debug lines only while the debug switch is on', () => {
    const dir = tmp();
    const clock = new Clock();
    let until = 0;
    const sink = new LogSink({ dir, now: clock.now, debugUntil: () => until });
    expect(sink.write('debug', 'x', 'off')).toBe(false);
    until = clock.t + 3_600_000;
    expect(sink.write('debug', 'x', 'on')).toBe(true);
    clock.t += 2 * 3_600_000;
    expect(sink.write('debug', 'x', 'expired')).toBe(false);
    sink.close();
    expect(readLines(dir).map((l) => l.msg)).toEqual(['on']);
  });

  test('a write that fails (no folder can be made) never throws and is reported once', () => {
    const base = tmp();
    const blocker = join(base, 'file');
    writeFileSync(blocker, 'x');
    const problems: string[] = [];
    const sink = new LogSink({ dir: join(blocker, 'logs'), onProblem: (m) => problems.push(m) });
    expect(sink.write('error', 'hub', 'one')).toBe(false);
    expect(sink.write('error', 'hub', 'two')).toBe(false);
    expect(problems.length).toBe(1);
    expect(sink.problem).toContain('Could not write the log file');
  });
});

describe('redaction', () => {
  test('a planted fake key never reaches a file, wherever it is put', () => {
    const dir = tmp();
    const sink = new LogSink({ dir });
    setLogTap(sink.tap);
    const log = logger('github');
    log.error(`request failed with ${FAKE_KEY}`, new Error(`401 for token ${FAKE_GH}`));
    log.warn('nested', { deep: { deeper: { value: `Bearer ${FAKE_KEY}` } }, list: [FAKE_GH] });
    log.info('named', { apiKey: 'plain-looking-value-123', password: 'hunter2hunter2', authorization: 'Basic abc', token: 'tk_short' });
    sink.write('info', 'client', 'event', { note: `url https://user:${'p4ssw0rd'}@example.com/x` });
    sink.close();
    const text = allText(dir);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_GH);
    expect(text).not.toContain('plain-looking-value-123');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).not.toContain('p4ssw0rd');
    expect(text).toContain('[redacted]');
    // the error still says what happened, and the stack came along
    const err = readLines(dir).find((l) => l.level === 'error')!;
    expect(err.fields?.error).toContain('401 for token');
    expect(typeof err.fields?.stack).toBe('string');
  });

  test('stdout gets the same filter, whatever the second argument is', () => {
    const printed: string[] = [];
    const [out, err] = [console.log, console.error];
    console.log = console.error = (...args: unknown[]) => void printed.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    try {
      const log = logger('github');
      log.warn('a string', `the answer was ${FAKE_KEY}`);
      log.warn('a list', [FAKE_GH, { token: 'plain-secret-1234' }]);
      log.warn('a class', new (class Thing {
        apiKey = 'plain-secret-5678';
        url = `https://x.example/?key=${FAKE_KEY}`;
      })());
      log.info('fields', { text: MESSAGE_TEXT, token: 'plain-secret-9999' });
    } finally {
      console.log = out;
      console.error = err;
    }
    const text = printed.join('\n');
    expect(printed).toHaveLength(4);
    for (const s of [FAKE_KEY, FAKE_GH, 'plain-secret-1234', 'plain-secret-5678', 'plain-secret-9999', MESSAGE_TEXT]) expect(text).not.toContain(s);
    expect(text).toContain('a string the answer was');
  });

  test('fields that hold content (text, prompt, input, output...) are left out', () => {
    const dir = tmp();
    const sink = new LogSink({ dir });
    sink.write('info', 'tool', 'tool call', { tool: 'Bash', input: { command: MESSAGE_TEXT }, output: MESSAGE_TEXT, text: MESSAGE_TEXT, prompt: MESSAGE_TEXT, content: [MESSAGE_TEXT] });
    sink.close();
    const text = allText(dir);
    expect(text).not.toContain(MESSAGE_TEXT);
    expect(readLines(dir)[0].fields).toEqual({ tool: 'Bash', input: '[omitted]', output: '[omitted]', text: '[omitted]', prompt: '[omitted]', content: '[omitted]' });
  });

  test('long strings and huge lines are cut', () => {
    const dir = tmp();
    const sink = new LogSink({ dir });
    sink.write('info', 'x', 'long', { a: 'a'.repeat(50_000) });
    sink.write('info', 'x', 'm'.repeat(30_000));
    sink.close();
    for (const line of readFileSync(listLogFiles(dir)[0].path, 'utf8').split('\n').filter(Boolean)) expect(line.length).toBeLessThan(16 * 1024);
  });

  test('exportConfig removes every secret and keeps references', () => {
    const { config, removed } = exportConfig({
      server: { token: 'owner-token-0123456789', port: 7717 },
      providers: { anthropic: { type: 'anthropic', apiKey: FAKE_KEY, apiKeyEnv: 'ANTHROPIC_API_KEY' }, ref: { type: 'openai', apiKey: '${secret:openai}' } },
      mcpServers: { db: { command: 'x', env: { DATABASE_URL: 'postgres://u:pw123456@h/db', PLAIN: 'value' }, headers: { 'X-Thing': 'abc' } }, gh: { url: 'https://x', headers: { Authorization: 'Bearer ${secret:github}' } } },
      notifications: { telegram: { botToken: '123456789:AAbbccddeeffgghhiijjkkllmmnnooppqqr' } },
      misc: { note: `a key ${FAKE_GH} in a string` },
    });
    const text = JSON.stringify(config);
    for (const s of ['owner-token-0123456789', FAKE_KEY, 'pw123456', FAKE_GH, '123456789:AAbb']) expect(text).not.toContain(s);
    expect((config.providers as any).anthropic.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    expect((config.providers as any).ref.apiKey).toBe('${secret:openai}');
    expect((config.mcpServers as any).db.env).toEqual({ DATABASE_URL: '[set]', PLAIN: '[set]' });
    expect((config.mcpServers as any).gh.headers.Authorization).toBe('Bearer ${secret:github}');
    expect((config.server as any).port).toBe(7717);
    expect(removed).toBeGreaterThanOrEqual(6);
  });
});

describe('engine events', () => {
  test('tool calls, approvals and routine runs: names, times and outcomes, never input or output', async () => {
    const dir = tmp();
    const home = tmp();
    const config = new ConfigStore(home);
    const logs = new HubLogs({ config: { get: () => config.get(), update: (p) => config.update(p), paths: { ...config.paths, logs: dir } }, version: '9.9.9' });
    const bus = new EventBus();
    logs.start({ bus });
    bus.emit({ type: 'tool.started', sessionId: 'ses_1', messageId: 'msg_1', toolUseId: 'tu_1', name: 'Bash', input: { command: `echo ${MESSAGE_TEXT} ${FAKE_KEY}` } });
    bus.emit({ type: 'tool.completed', sessionId: 'ses_1', toolUseId: 'tu_1', result: { type: 'tool_result', toolUseId: 'tu_1', content: MESSAGE_TEXT, isError: true, meta: { exitCode: 2, durationMs: 31 } } });
    bus.emit({ type: 'approval.requested', approval: { id: 'apr_1', sessionId: 'ses_1', toolUseId: 'tu_2', tool: 'Bash', input: { command: MESSAGE_TEXT }, summary: `Run: ${MESSAGE_TEXT}`, createdAt: Date.now() - 500 } });
    bus.emit({ type: 'approval.resolved', id: 'apr_1', sessionId: 'ses_1', response: { decision: 'deny', message: MESSAGE_TEXT } });
    bus.emit({ type: 'routine.run', run: { id: 'run_1', routineId: 'rt_1', status: 'running', trigger: 'schedule', startedAt: Date.now() } });
    bus.emit({ type: 'routine.run', run: { id: 'run_1', routineId: 'rt_1', status: 'ok', trigger: 'schedule', startedAt: Date.now() - 1000, finishedAt: Date.now(), summary: MESSAGE_TEXT } });
    // a session's error notice is its turn's error, logged with the turn; a hub-wide one has its own line
    bus.emit({ type: 'notice', notice: { id: 'n1', title: 'Session error', body: MESSAGE_TEXT, level: 'error', sessionId: 'ses_1', createdAt: Date.now() } });
    bus.emit({ type: 'notice', notice: { id: 'n2', title: 'Routine failed', body: MESSAGE_TEXT, level: 'error', createdAt: Date.now() } });
    logTurn({ sessionId: 'ses_1', agent: 'assistant', model: 'anthropic/claude-sonnet-5-5', startedAt: Date.now() - 2000, stop: 'done', tools: 1, usage: { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0012 } });
    logs.stop('test');
    const text = allText(dir);
    expect(text).not.toContain(MESSAGE_TEXT);
    expect(text).not.toContain(FAKE_KEY);
    const lines = readLines(dir);
    const ev = (c: string, m: string) => lines.find((l) => l.component === c && l.msg === m);
    expect(ev('hub', 'hub started')?.fields?.version).toBe('9.9.9');
    expect(ev('tool', 'tool call')?.fields).toEqual({ sessionId: 'ses_1', tool: 'Bash', durationMs: 31, ok: false, exitCode: 2 });
    expect(ev('approval', 'approval asked')?.fields).toEqual({ id: 'apr_1', sessionId: 'ses_1', tool: 'Bash' });
    expect(ev('approval', 'approval answered')?.fields?.decision).toBe('deny');
    expect(typeof ev('approval', 'approval answered')?.fields?.waitMs).toBe('number');
    expect(ev('routine', 'routine run')?.fields).toMatchObject({ routineId: 'rt_1', runId: 'run_1', status: 'ok', trigger: 'schedule' });
    expect(lines.filter((l) => l.component === 'notice').map((l) => l.fields)).toEqual([{ title: 'Routine failed' }]);
    expect(ev('session', 'turn')?.fields).toMatchObject({ sessionId: 'ses_1', agent: 'assistant', model: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', stop: 'done', calls: 2, inputTokens: 100, outputTokens: 20, costUsd: 0.0012 });
    expect(ev('hub', 'hub stopped')?.fields).toMatchObject({ version: '9.9.9', reason: 'test' });
    // the tap is gone after stop
    expect(currentLogTap()).toBeUndefined();
  });

  test('the debug switch: on for hours, written in config, a line each way', () => {
    const dir = tmp();
    const home = tmp();
    const config = new ConfigStore(home);
    const clock = new Clock();
    const logs = new HubLogs({ config: { get: () => config.get(), update: (p) => config.update(p), paths: { ...config.paths, logs: dir } }, version: 't', now: clock.now });
    logs.start();
    logger('x').debug('hidden');
    const until = logs.setDebug(24);
    expect(until).toBe(clock.t + 24 * 3_600_000);
    expect(config.get().logs?.debugUntil).toBe(until);
    logger('x').debug('shown');
    clock.t += 25 * 3_600_000;
    logger('x').debug('hidden again');
    logs.setDebug(0);
    logs.stop();
    const msgs = readLines(dir).map((l) => l.msg);
    expect(msgs).toContain('debug on');
    expect(msgs).toContain('shown');
    expect(msgs).not.toContain('hidden');
    expect(msgs).not.toContain('hidden again');
    expect(() => logs.setDebug(500)).toThrow();
  });
});

describe('client lines', () => {
  function hub(clock = new Clock()) {
    const dir = tmp();
    const config = new ConfigStore(tmp());
    const logs = new HubLogs({ config: { get: () => config.get(), update: (p) => config.update(p), paths: { ...config.paths, logs: dir } }, version: 't', now: clock.now });
    return { dir, logs, clock };
  }
  const tag = { id: 'cl_1', device: 'Chrome on macOS', app: 'app' };

  test('stored in the same files with the device, app, version and platform', () => {
    const { dir, logs } = hub();
    const r = logs.ingestClient(tag, { app: 'web', version: '0.1.0', platform: 'macOS', events: [{ level: 'warn', event: 'request.failed', msg: 'Hub error 502', fields: { status: 502, path: '/api/sessions' } }] });
    expect(r).toEqual({ accepted: 1, dropped: 0 });
    logs.sink.close();
    expect(readLines(dir)[0]).toMatchObject({ level: 'warn', component: 'client', msg: 'request.failed', fields: { status: 502, path: '/api/sessions', error: 'Hub error 502' }, client: { id: 'cl_1', device: 'Chrome on macOS', app: 'web', version: '0.1.0', platform: 'macOS' } });
  });

  test('a batch is capped, and so is a client per minute; the drop is one line', () => {
    const { dir, logs, clock } = hub();
    const ev = (i: number) => ({ level: 'info', event: 'connect', fields: { i } });
    const first = logs.ingestClient(tag, { app: 'web', events: Array.from({ length: CLIENT_BATCH_MAX + 10 }, (_, i) => ev(i)) });
    expect(first).toEqual({ accepted: CLIENT_BATCH_MAX, dropped: 10 });
    let accepted = first.accepted;
    for (let i = 0; i < 5; i++) accepted += logs.ingestClient(tag, { app: 'web', events: Array.from({ length: 40 }, (_, j) => ev(j)) }).accepted;
    expect(accepted).toBe(CLIENT_PER_MINUTE);
    // another client has its own allowance
    expect(logs.ingestClient({ ...tag, id: 'cl_2' }, { app: 'android', events: [ev(1)] }).accepted).toBe(1);
    // a minute later the first one may send again
    clock.t += 61_000;
    expect(logs.ingestClient(tag, { app: 'web', events: [ev(1)] }).accepted).toBe(1);
    logs.sink.close();
    const drops = readLines(dir).filter((l) => l.msg === 'client lines dropped');
    expect(drops.length).toBe(1);
  });

  test("a member's apps together get far fewer lines an hour than an app of the owner's", () => {
    const { dir, logs, clock } = hub();
    const ev = (i: number) => ({ level: 'info', event: 'connect', fields: { i } });
    const sent = (id: string, account?: string) => logs.ingestClient({ ...tag, id, ...(account ? { account } : {}) }, { app: 'web', events: Array.from({ length: 40 }, (_, j) => ev(j)) }).accepted;
    // bob pairs a second app: it does not get him a second allowance
    let bob = 0;
    for (let i = 0; i < 3; i++) bob += sent('cl_bob_web', 'acc_bob') + sent('cl_bob_phone', 'acc_bob');
    expect(bob).toBe(MEMBER_PER_HOUR);
    // a minute later still none: the cap is per hour
    clock.t += 61_000;
    expect(sent('cl_bob_web', 'acc_bob')).toBe(0);
    // the owner's app (and the owner's account sent as such) keeps the app allowance
    expect(sent('cl_owner') + sent('cl_owner') + sent('cl_owner', 'owner')).toBe(CLIENT_PER_MINUTE);
    // another member has their own
    expect(sent('cl_cara', 'acc_cara')).toBe(40);
    // the next hour bob may send again
    clock.t += 3_600_000;
    expect(sent('cl_bob_web', 'acc_bob')).toBe(40);
    logs.sink.close();
    const lines = readLines(dir).filter((l) => l.client?.account === 'acc_bob' && l.msg === 'connect');
    expect(lines.length).toBe(MEMBER_PER_HOUR + 40);
  });

  test('sizes and shapes are cut; content fields and keys never pass', () => {
    const { dir, logs } = hub();
    const fields: Record<string, unknown> = { text: MESSAGE_TEXT, token: FAKE_KEY, obj: { nested: true }, long: 'l'.repeat(1000) };
    for (let i = 0; i < 20; i++) fields[`k${i}`] = i;
    logs.ingestClient(tag, { app: 'x'.repeat(100), version: 'v'.repeat(100), events: [{ level: 'nope', event: 'bad event name!'.repeat(10), msg: `boom ${FAKE_GH} ${'m'.repeat(1000)}`, fields }] });
    logs.sink.close();
    const text = allText(dir);
    expect(text).not.toContain(MESSAGE_TEXT);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_GH);
    const l = readLines(dir)[0];
    expect(l.level).toBe('info');
    expect(l.msg.length).toBeLessThanOrEqual(64);
    expect(l.client!.app.length).toBeLessThanOrEqual(24);
    expect(Object.keys(l.fields!).length).toBeLessThanOrEqual(13);
    expect((l.fields!.long as string).length).toBeLessThanOrEqual(200);
    expect(l.fields!.obj).toBeUndefined();
  });
});

describe('reader', () => {
  function seed(dir: string, clock: Clock) {
    const sink = new LogSink({ dir, now: clock.now });
    clock.t -= DAY;
    sink.write('error', 'runner', 'turn failed in ses_01JABCDEF123', { error: 'boom 1' });
    sink.write('info', 'session', 'turn', { sessionId: 'ses_1', model: 'a/b', stop: 'error', durationMs: 10, costUsd: 0.5, inputTokens: 5, outputTokens: 1 });
    clock.t += DAY;
    sink.write('error', 'runner', 'turn failed in ses_01JZZZZZZ999', { error: 'boom 2' });
    sink.write('warn', 'peer', 'delivery failed', { friendId: 'fr_1' });
    sink.write('info', 'session', 'turn', { sessionId: 'ses_2', model: 'a/b', stop: 'done', durationMs: 20, costUsd: 0.25, inputTokens: 7, outputTokens: 2 });
    sink.write('info', 'tool', 'tool call', { tool: 'Bash', ok: false });
    sink.write('info', 'tool', 'tool call', { tool: 'Read', ok: true });
    sink.write('info', 'hub', 'hub started', { version: '1.2.3' });
    sink.close();
  }

  test('tail, then follow from the cursor; filters by level and component', async () => {
    const dir = tmp();
    const clock = new Clock();
    seed(dir, clock);
    const r = new LogReader(dir, clock.now);
    const last = await r.tail({ lines: 3 });
    expect(last.lines.map((l) => l.msg)).toEqual(['tool call', 'tool call', 'hub started']);
    const errs = await r.tail({ lines: 10, level: 'warn' });
    expect(errs.lines.map((l) => l.level)).toEqual(['error', 'error', 'warn']);
    expect((await r.tail({ component: 'session' })).lines.length).toBe(2);
    const sink = new LogSink({ dir, now: clock.now });
    sink.write('info', 'hub', 'later');
    sink.close();
    const more = await r.tail({ after: last.cursor });
    expect(more.lines.map((l) => l.msg)).toEqual(['later']);
    expect((await r.tail({ after: more.cursor })).lines).toEqual([]);
    // a line an older hub wrote with a key in it is filtered on the way out too
    const file = listLogFiles(dir).pop()!.path;
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ time: new Date(clock.t).toISOString(), level: 'warn', component: 'old', msg: `leaked ${FAKE_KEY}`, fields: { token: 'abc12345678' } }) + '\n');
    const leaked = await r.tail({ lines: 1 });
    expect(JSON.stringify(leaked)).not.toContain(FAKE_KEY);
    expect(leaked.lines[0].fields).toEqual({ token: '[redacted]' });
    expect(JSON.stringify(await r.errors(7))).not.toContain(FAKE_KEY);
  });

  test('errors group with ids and numbers folded; counts by day', async () => {
    const dir = tmp();
    const clock = new Clock();
    seed(dir, clock);
    const r = new LogReader(dir, clock.now);
    const rep = await r.errors(7);
    expect(rep.errors).toBe(2);
    expect(rep.warnings).toBe(1);
    expect(rep.top.length).toBe(1);
    expect(rep.top[0]).toMatchObject({ component: 'runner', count: 2 });
    expect(rep.byComponent[0]).toEqual({ component: 'runner', errors: 2, warnings: 0 });
    expect(foldMessage('turn failed in ses_01JABCDEF123 after 1234ms')).toBe('turn failed in <id> after 1234ms'.replace('1234', 'N'));
    const c = await r.counts();
    expect(c).toEqual({ errorsToday: 1, warningsToday: 1, errorsWeek: 2 });
    // only the new part of today's file is read the next time
    expect(await r.counts()).toEqual(c);
    const s = await r.stats(1);
    expect(s.turns.total).toBe(1);
    expect(s.tools).toMatchObject({ total: 2, failed: 1 });
    expect(s.hubStarts).toEqual([{ time: expect.any(String), version: '1.2.3' }]);
  });
});

describe('export', () => {
  test('a zip with summary.md, config.json without secrets, the files and device logs', async () => {
    const dir = tmp();
    const clock = new Clock();
    const sink = new LogSink({ dir, now: clock.now });
    sink.write('info', 'hub', 'hub started', { version: '2.0.0' });
    sink.write('info', 'session', 'turn', { sessionId: 'ses_1', model: 'anthropic/x', provider: 'anthropic', stop: 'done', durationMs: 900, inputTokens: 10, outputTokens: 3, costUsd: 0.01 });
    sink.write('error', 'github', 'github request failed', { status: 502, error: 'GitHub did not answer' });
    sink.close();
    // a line written by an older hub with a key in it is filtered on the way out
    const file = listLogFiles(dir)[0].path;
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ time: new Date(clock.t).toISOString(), level: 'warn', component: 'old', msg: `leaked ${FAKE_KEY}` }) + '\n');
    // and one whose secret and chat text are in fields named for them, in no shape the patterns know: as tail filters it
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ time: new Date(clock.t).toISOString(), level: 'info', component: 'old', msg: 'hand edited', fields: { token: 'plain-secret-1234', prompt: MESSAGE_TEXT, sessionId: 'ses_old' } }) + '\n');
    const ring = new LogRing();
    ring.push(`2026-10-21T10:00:00Z ● online with ${FAKE_GH}`);
    const out = await logsExport({
      reader: new LogReader(dir, clock.now),
      days: 7,
      now: clock.t,
      hub: { name: 'Madx Hub', version: '2.0.0', startedAt: clock.t - 3_600_000 },
      status: { dir, keepDays: 28, maxMB: 500 },
      devices: [
        { id: 'local', name: 'madx', online: true, platform: 'linux x64', daemon: 'the hub itself' },
        { id: 'dev_abc123', name: 'MacBook', online: true, platform: 'darwin arm64', daemon: 'rust 0.2.0' },
        { id: 'dev_zzz999', name: 'Old PC', online: false },
      ],
      providers: ['anthropic', 'claude-code (harness)'],
      config: { server: { token: 'owner-token-0123456789abcdef', port: 7717 }, providers: { anthropic: { type: 'anthropic', apiKey: FAKE_KEY } } },
      daemons: [
        { deviceId: 'dev_abc123', name: 'MacBook', tail: daemonLogTail({ impl: 'rust', version: '0.2.0', ring, lines: 10 }) },
        { deviceId: 'dev_zzz999', name: 'Old PC', error: 'offline' },
      ],
    });
    expect(out.name).toBe('conclave-logs-madx-hub-2026-10-21.zip');
    const bytes = new Uint8Array(await new Response(out.stream).arrayBuffer());
    const files = readZip(bytes);
    const root = 'conclave-logs-madx-hub-2026-10-21';
    expect([...files.keys()].sort()).toEqual([`${root}/config.json`, `${root}/devices/macbook-abc123.log`, `${root}/logs/hub-2026-10-21.jsonl`, `${root}/summary.md`]);
    const dec = new TextDecoder();
    const all = [...files.values()].map((b) => dec.decode(b)).join('\n');
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain(FAKE_GH);
    expect(all).not.toContain('owner-token-0123456789abcdef');
    expect(all).not.toContain('plain-secret-1234');
    expect(all).not.toContain(MESSAGE_TEXT);
    const edited = dec
      .decode(files.get(`${root}/logs/hub-2026-10-21.jsonl`)!)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine)
      .find((l) => l.msg === 'hand edited')!;
    expect(edited.fields).toEqual({ token: '[redacted]', prompt: '[omitted]', sessionId: 'ses_old' });
    const summary = dec.decode(files.get(`${root}/summary.md`)!);
    expect(summary).toContain('Version: 2.0.0');
    expect(summary).toContain('Up for: 1h 0m');
    expect(summary).toContain('| MacBook | dev_abc123 | yes | darwin arm64 | rust 0.2.0 |');
    expect(summary).toContain('anthropic, claude-code (harness)');
    expect(summary).toContain('| Turns | 1 (done 1) |');
    expect(summary).toContain('| github | 1 | 0 |');
    expect(summary).toContain('github request failed: GitHub did not answer');
    expect(summary).toContain('Old PC (dev_zzz999): no log, offline');
    const cfg = JSON.parse(dec.decode(files.get(`${root}/config.json`)!));
    expect(cfg.server).toEqual({ port: 7717 });
    expect(dec.decode(files.get(`${root}/devices/macbook-abc123.log`)!)).toContain('online with [redacted]');
    // every unzip tool reads it
    const zipPath = join(tmp(), 'x.zip');
    writeFileSync(zipPath, bytes);
    const unzip = Bun.which('unzip');
    if (unzip) expect(spawnSync(unzip, ['-t', zipPath]).status).toBe(0);
  });

  test('zip: many entries and a streamed one round trip', async () => {
    const big = new TextEncoder().encode('line\n'.repeat(100_000));
    const stream = zipStream([
      { name: 'a.txt', data: 'hello' },
      {
        name: 'dir/b.bin',
        data: async function* () {
          yield big.subarray(0, 1000);
          yield big.subarray(1000);
        },
      },
      { name: 'empty', data: '' },
    ]);
    const files = readZip(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect(files.get('dir/b.bin')!.byteLength).toBe(big.byteLength);
    expect(files.get('empty')!.byteLength).toBe(0);
  });
});

describe('crashes', () => {
  test('an uncaught error is written with its stack, then the process exits with 1', () => {
    const dir = tmp();
    const sink = new LogSink({ dir });
    setLogTap(sink.tap);
    const codes: number[] = [];
    const quiet = console.error;
    const printed: string[] = [];
    console.error = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
    const off = installCrashLogging((c) => codes.push(c));
    try {
      process.emit('uncaughtException', new Error(`kaboom with ${FAKE_KEY}`), 'uncaughtException');
    } finally {
      off();
      console.error = quiet;
    }
    sink.close();
    expect(codes).toEqual([1]);
    // stderr gets the stack too, filtered like every other line there
    expect(printed.join('\n')).toContain('kaboom');
    expect(printed.join('\n')).not.toContain(FAKE_KEY);
    expect(allText(dir)).not.toContain(FAKE_KEY);
    const line = readLines(dir).find((l) => l.msg === 'unhandled error')!;
    expect(line.level).toBe('error');
    expect(line.fields).toMatchObject({ kind: 'uncaughtException', error: 'kaboom with [redacted]' });
    expect(String(line.fields?.stack)).toContain('kaboom');
  });
});

describe('daemon log ring', () => {
  test('keeps the last lines, strips colors and filters secrets, reads the end of the log file', () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i++) ring.push(`\x1b[32mline ${i}\x1b[0m`);
    expect(ring.tail()).toEqual(['line 2', 'line 3', 'line 4']);
    const dir = tmp();
    const file = join(dir, 'daemon.log');
    writeFileSync(file, Array.from({ length: 30 }, (_, i) => `old ${i} ${i === 29 ? FAKE_KEY : ''}`).join('\n') + '\n');
    const t = daemonLogTail({ impl: 'ts', version: '1', file, ring, lines: 5 });
    expect(t.lines).toEqual(['line 2', 'line 3', 'line 4']);
    expect(t.file?.length).toBe(5);
    expect(t.file?.join('\n')).not.toContain(FAKE_KEY);
    expect(daemonLogTail({ impl: 'ts', file: join(dir, 'missing'), ring }).file).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });
});
