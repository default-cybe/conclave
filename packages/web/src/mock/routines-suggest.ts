/**
 * Mock routes for suggested routines (docs/design/ECOSYSTEM.md 2.3), served
 * by the hub's own RoutineSuggestions service over the mock's data, so the
 * Routines tab sees the same list, needs and refusals as on a real hub. The
 * gaps closed are the real hub's (CLOSED_GAPS). Registered before Discover's
 * module, so these handlers answer the suggestion routes.
 *
 * It also gives a few seeded runs the new run fields (outcome from the STATUS
 * line, calls refused while nobody was there) so the run timeline shows them.
 */
import type { AgentDef } from '@conclave/core/extensions/types';
import type { McpServerConfig } from '@conclave/core/config/schema';
import type { Routine, RoutineRun } from '@conclave/core/types';
import { RoutineSuggestions, SuggestionError, type SuggestionHost } from '@conclave/core/scheduler/suggest';
import * as D from './data';
import type { MockCtx } from './index';

/** The parts of an agent file the mock shows: name, description, lists, prompt. */
function parseAgent(name: string, md: string): AgentDef {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  const head = m?.[1] ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n[A-Za-z]+:|$)`, 'm').exec(head)?.[1]?.replace(/\s+/g, ' ').trim();
  const list = (k: string) =>
    new RegExp(`^${k}:\\n((?:\\s+- .*\\n?)+)`, 'm')
      .exec(head)?.[1]
      ?.split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
  return {
    name,
    description: field('description') ?? name,
    prompt: (m?.[2] ?? md).trim(),
    ...(field('color') ? { color: field('color') } : {}),
    ...(field('icon') ? { icon: field('icon') } : {}),
    ...(list('disallowedTools') ? { disallowedTools: list('disallowedTools') } : {}),
    source: 'user',
    path: `~/.conclave/agents/${name}.md`,
  } as AgentDef;
}

export function registerRoutinesSuggest(ctx: MockCtx) {
  const { on, db, fail, sleep } = ctx;
  const cfg = db.config as { mcpServers?: Record<string, McpServerConfig> };

  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const r = await ctx.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${r.status}`);
    return data as T;
  };

  const host: SuggestionHost = {
    routines: () => [...db.routines.values()],
    createRoutine: (input) => call<Routine>('/api/routines', 'POST', input),
    removeRoutine: async (id) => void (await call('/api/routines/' + encodeURIComponent(id), 'DELETE')),
    agentExists: (name) => db.agents.some((a) => a.name === name),
    createAgent: async (name, md) => {
      db.agents.push(parseAgent(name, md));
    },
    mcpServers: () => Object.entries(cfg.mcpServers ?? {}).filter(([, s]) => s?.enabled !== false).map(([n]) => n),
    secrets: () => db.values,
    devices: () => [...db.devices.values()],
    checkSchedule: async (schedule, timezone) => {
      const q = new URLSearchParams({ schedule, ...(timezone ? { timezone } : {}) });
      const res = await call<{ next: number[]; error?: string }>(`/api/routines/preview?${q}`);
      if (res.error) throw new Error(res.error);
    },
  };
  const svc = new RoutineSuggestions(host);

  on('GET', '/api/routines/suggestions', async () => {
    await sleep(120);
    return svc.list();
  });

  on('POST', '/api/routines/suggestions/:id/add', async ({ params, body }) => {
    await sleep(450);
    try {
      return await svc.add(decodeURIComponent(params[0]), body ?? {});
    } catch (e) {
      if (e instanceof SuggestionError) return fail(e.status, e.message);
      throw e;
    }
  });

  if (ctx.FRESH) return;

  // seeded runs in the shape the hub now records
  const runs = D.routineRuns as Record<string, RoutineRun[]>;
  const lib = runs.r_librarian?.[0];
  if (lib) {
    Object.assign(lib, {
      summary: 'STATUS: attention\nMerged 3 notes, retired 1 fact, 2 conflicts wait in Librarian review.',
      outcome: 'attention',
      denied: [{ tool: 'mcp__basic-memory__delete_note', input: 'delete_note "Proxmox old"', rule: 'mcp__basic-memory__delete_note' }],
    } satisfies Partial<RoutineRun>);
  }
  for (const r of runs.r_watchdog ?? []) if (r.status === 'ok') Object.assign(r, { outcome: 'ok' });
  const librarian = db.routines.get('r_librarian');
  if (librarian && !librarian.allow) Object.assign(librarian, { allow: ['MemorySave', 'MemoryForget', 'mcp__basic-memory__write_note', 'mcp__basic-memory__edit_note'], notify: 'on_attention' });
}
