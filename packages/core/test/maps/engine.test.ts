/**
 * Maps on a real engine with the scripted model and the fake Google: the
 * assistant runs PlaceSearch, Directions and MapImage without asking, the
 * results carry cards, the chat agent has the tools and untrusted agents do
 * not, the day plan gets leave-by times through the calendar port, and the
 * Google key never shows up in a tool's environment, the transcript, what
 * the model is sent, the card data, the database or the logs.
 *
 *   bun test packages/core/test/maps/engine.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapsOf, setCalendarPort, MAPS_KEY, type MapsCardData } from '../../src/maps';
import { builtinTools, filterTools, UNTRUSTED_DENY } from '../../src/tools';
import { addDays, atLocal, localDate } from '../../src/assistant/time';
import { assistantOf } from '../../src/assistant';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { FAKE_KEY, PLACES, startFakeGoogle, type FakeGoogle } from './fakes';

const ENV_KEY = 'AIzaSyENVKEY-zyxwvutsrqponmlkjihgfedcba';
const MAPS = ['PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage'];

let t: TestEngine | undefined;
let google: FakeGoogle | undefined;
let logged: string[] = [];
const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };

beforeEach(() => {
  google = startFakeGoogle();
  process.env.CONCLAVE_MAPS_GOOGLE_URL = google.url;
  // an install that also sets the key in the environment: shells must not inherit it
  process.env.GOOGLE_MAPS_API_KEY = ENV_KEY;
  logged = [];
  for (const k of ['log', 'error', 'warn', 'info', 'debug'] as const)
    console[k] = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
});

afterEach(async () => {
  Object.assign(console, saved);
  await t?.close();
  google?.stop();
  delete process.env.CONCLAVE_MAPS_GOOGLE_URL;
  delete process.env.GOOGLE_MAPS_API_KEY;
  t = undefined;
  google = undefined;
});

describe('maps on the engine', () => {
  test('the assistant finds a place, a route and a map; the key stays on the hub', async () => {
    t = await startTestEngine({
      approve: 'allow',
      script: [
        [{ tool: 'PlaceSearch', input: { query: 'coffee', near: 'home' } }],
        [{ tool: 'Directions', input: { to: PLACES[0].id, mode: 'transit' } }],
        [{ tool: 'MapImage', input: { markers: [{ at: 'home' }, { at: PLACES[0].id }] } }],
        [{ tool: 'Bash', input: { command: 'env; true' } }],
        // the private guard refuses a shell command that names secrets.json (machine/private.ts)
        [{ tool: 'Bash', input: { command: 'cat ~/.conclave/secrets.json 2>/dev/null; true' } }],
        [{ text: 'Café Linde is open now, 7 min by transit.' }],
      ],
    });
    const { engine } = t;
    // `conclave secret google-maps` stores it with the provider keys
    engine.config.setSecret('providers', MAPS_KEY, FAKE_KEY);
    const maps = mapsOf(engine)!;
    expect(maps.settings()).toMatchObject({ provider: 'google', google: { keySet: true, keyFrom: 'hub' } });
    await maps.patch({ home: '52.5294,13.401' });

    const s = await engine.createSession({ cwd: t.cwd });
    expect(s.agent).toBe('assistant');
    await t.run(s.id, 'Where can I get coffee near home, and how long is it by transit? Show me a map.');

    // read-only: nothing asked but the shell command
    expect(t.approvals.filter((a) => /PlaceSearch|Directions|MapImage|Find|Map of/.test(a))).toEqual([]);
    const msgs = engine.getMessages(s.id);
    const results = msgs.flatMap((m) => m.content).filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result');
    const cards = results.map((r) => (r.meta as { maps?: MapsCardData } | undefined)?.maps).filter((c): c is MapsCardData => !!c);
    expect(cards.map((c) => c.kind)).toEqual(['places', 'route', 'map']);
    const place = cards[0] as Extract<MapsCardData, { kind: 'places' }>;
    expect(place.places[0]).toMatchObject({ name: 'Café Linde', rating: 4.6, openNow: true });
    const text = results.map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content))).join('\n');
    expect(text).toContain('Café Linde');
    expect(text).toContain('Transit from Home to Café Linde');
    expect(google!.requests.length).toBeGreaterThanOrEqual(3);
    expect(google!.requests.every((r) => r.headers['x-goog-api-key'] === FAKE_KEY || r.query.key === FAKE_KEY)).toBe(true);

    const bash = results.find((r) => typeof r.content === 'string' && r.content.includes('PATH='));
    expect(bash).toBeDefined();
    const secretsRead = results.find((r) => JSON.stringify(r.content).includes("Refused: that file holds the hub's keys"));
    expect(secretsRead?.isError).toBe(true);
    for (const key of [FAKE_KEY, ENV_KEY]) {
      // tool environment
      expect(String(bash!.content)).not.toContain(key);
      // the transcript and the card data the clients get
      expect(JSON.stringify(msgs)).not.toContain(key);
      // what the model was sent
      for (const body of [...t.requests, ...t.chores]) expect(body).not.toContain(key);
      // the database on disk
      for (const f of ['conclave.db', 'conclave.db-wal']) {
        const p = join(t.home, f);
        if (existsSync(p)) expect(readFileSync(p).includes(Buffer.from(key))).toBe(false);
      }
      // the logs
      expect(logged.join('\n')).not.toContain(key);
    }
    // the map card's picture comes from the hub
    const img = await maps.imageBytes((cards[2] as Extract<MapsCardData, { kind: 'map' }>).image.id);
    expect(img.type).toBe('image/png');
  });

  test('a refused key fails the tool in plain words, without the key, and the turn goes on', async () => {
    t = await startTestEngine({ script: [[{ tool: 'PlaceSearch', input: { query: 'coffee' } }], [{ text: 'Maps are not set up.' }]] });
    t.engine.config.setSecret('providers', MAPS_KEY, FAKE_KEY);
    google!.fail.places = 'billing';
    const s = await t.engine.createSession({ cwd: t.cwd });
    await t.run(s.id, 'coffee?');
    const r = t.engine.getMessages(s.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string; isError?: boolean; meta?: { code?: string } };
    expect(r.isError).toBe(true);
    expect(r.meta?.code).toBe('MAPS_BILLING');
    expect(r.content).toContain('Billing is not enabled');
    expect(JSON.stringify(t.engine.getMessages(s.id))).not.toContain(FAKE_KEY);
    expect(logged.join('\n')).not.toContain(FAKE_KEY);
  });

  test('the chat agent has the maps tools; untrusted agents never do', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const chat = await t.engine.createSession({ agent: 'chat', cwd: t.cwd });
    const names = t.engine.toolsFor(chat, t.engine.agentFor(chat), 'agent', 0).map((x) => x.name);
    for (const n of MAPS) expect(names).toContain(n);
    const assistant = await t.engine.createSession({ cwd: t.cwd });
    const own = t.engine.toolsFor(assistant, t.engine.agentFor(assistant), 'agent', 0).map((x) => x.name);
    for (const n of MAPS) expect(own).toContain(n);
    for (const n of MAPS) expect(UNTRUSTED_DENY).toContain(n);
    // an untrusted agent that names them in its tools list still does not get them
    expect(filterTools(builtinTools(), { untrusted: true, allow: MAPS }).map((x) => x.name)).toEqual([]);
    // a chat with web search off stays offline: no maps either
    const off = await t.engine.createSession({ kind: 'chat', cwd: t.cwd, chat: { webSearch: false } } as never);
    const offNames = t.engine.toolsFor(t.engine.getSession(off.id)!, t.engine.agentFor(off), 'agent', 0).map((x) => x.name);
    for (const n of MAPS) expect(offNames).not.toContain(n);
    expect(offNames).not.toContain('WebSearch');
    expect(offNames).toContain('MemorySearch');
  });

  test('DayPlan ends with leave-by times for events with a place, through the calendar port', async () => {
    const zone = 'Europe/Berlin';
    // tomorrow, so the event is ahead whenever the test runs
    const day = addDays(localDate(Date.now(), zone), 1);
    t = await startTestEngine({ script: [[{ tool: 'DayPlan', input: { date: day } }], [{ text: 'Planned.' }]] });
    t.engine.config.setSecret('providers', MAPS_KEY, FAKE_KEY);
    const a = assistantOf(t.engine)!;
    await a.setPrefs({ timezone: 'Europe/Berlin' });
    const maps = mapsOf(t.engine)!;
    await maps.patch({ home: '52.5294,13.401', mode: 'transit' });
    const start = atLocal(day, '18:00', zone);
    setCalendarPort(t.engine, { eventsBetween: async (s, e) => [{ id: 'ev1', title: 'Coffee with Mia', start, location: 'Café Linde, Linienstraße 40' }].filter((x) => x.start >= s && x.start < e) });
    const s = await t.engine.createSession({ cwd: t.cwd });
    await t.run(s.id, 'plan my day');
    const res = t.engine.getMessages(s.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string };
    expect(res.content).toContain('Travel from home for events with a place. Put each leave-by time in the plan as a reminder item:');
    expect(res.content).toMatch(/- Leave by 17:\d\d for Coffee with Mia at 18:00 \(Café Linde, Linienstraße 40\): \d+ min by transit\./);
    const dto = await maps.leaveBy(day);
    expect(dto.items[0]).toMatchObject({ title: 'Coffee with Mia', startText: '18:00', mode: 'transit' });
  });
});
