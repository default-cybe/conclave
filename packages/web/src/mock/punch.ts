/**
 * Mock routes. Hub backup and restore (GET /api/backup, POST /api/restore),
 * plus the config the punch list added: the default device for new sessions
 * and the gateway route switches.
 *
 * The busy hub keeps new sessions on arch-desktop and has /gw/gemini turned
 * off (Gemini CLI is not installed anywhere). A first-run hub has neither.
 */
import type { BackupCounts, HubBackup, RestoreResult } from '@conclave/core/client';
import type { AgentDef } from '@conclave/core/extensions/types';
import type { MemoryEntry, Message, Routine, Session, Task } from '@conclave/core/types';
import { DEFAULT_CONFIG } from '@conclave/core/config/schema';
import type { MockCtx } from './index';

const SECRET_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;
const PLACEHOLDER = /\$\{(?:(?:env|secret):[^}]+|[A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Same as core isReference: placeholders and at most an auth scheme word ("Bearer ${secret:github}"). */
function isReference(value: string): boolean {
  const rest = value.replace(PLACEHOLDER, '');
  return rest !== value && /^\s*(?:bearer|basic|token)?\s*$/i.test(rest);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Same rule as core/engine/backup.ts: drop secret values, keep *Env names and references like "Bearer ${secret:x}". */
function redact(config: Record<string, unknown>): { config: Record<string, unknown>; redacted: string[] } {
  const redacted: string[] = [];
  const walk = (v: unknown, path: string[]): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && SECRET_KEY.test(k) && !/Env$/.test(k) && !isReference(val)) {
        redacted.push([...path, k].join('.'));
        continue;
      }
      out[k] = walk(val, [...path, k]);
    }
    return out;
  };
  return { config: walk(config, []) as Record<string, unknown>, redacted };
}

/** What config.json would hold: only the values that differ from the defaults. */
function userPart(cfg: Record<string, unknown>, base: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    const b = base?.[k];
    if (isObject(v) && isObject(b)) {
      const d = userPart(v, b);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = structuredClone(v);
  }
  return out;
}

/** A user agent as the markdown file ~/.conclave/agents/<name>.md holds. */
function agentFile(a: AgentDef): { file: string; content: string } {
  const fm = [`name: ${a.name}`, `description: ${a.description}`, a.model ? `model: ${a.model}` : '', a.device ? `device: ${a.device}` : '', a.tools?.length ? `tools: ${a.tools.join(', ')}` : ''].filter(Boolean);
  return { file: `${a.name}.md`, content: `---\n${fm.join('\n')}\n---\n\n${a.prompt}\n` };
}

/** Read back what agentFile wrote: the front matter fields the mock uses and the prompt. */
function fromAgentFile(file: string, content: string): AgentDef | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const name = fm.name || file.replace(/\.md$/, '');
  return {
    name,
    description: fm.description ?? '',
    prompt: (m?.[2] ?? content).trim(),
    ...(fm.model ? { model: fm.model } : {}),
    ...(fm.device ? { device: fm.device } : {}),
    ...(fm.tools ? { tools: fm.tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    source: 'user',
  };
}

const zero = (): BackupCounts => ({ agents: 0, routines: 0, tasks: 0, memories: 0, sessions: 0, messages: 0 });

export function registerPunch(ctx: MockCtx) {
  const { on, db } = ctx;

  if (!ctx.FRESH) {
    db.config.defaultDevice ??= 'arch-desktop';
    db.config.gateway ??= { routes: { gemini: false } };
    // a web search key: a secret config field that a backup leaves out
    const search = db.config.search as { provider?: string; apiKey?: string } | undefined;
    if (search && !search.apiKey) db.config.search = { ...search, provider: 'brave', apiKey: 'BSAm2vq0c4h7rj1x9wz5ny3pkd6tb' };
  }

  on('GET', '/api/backup', async ({ query }) => {
    const secrets = query.get('secrets') === '1' || query.get('secrets') === 'true';
    const withSessions = query.get('sessions') !== '0' && query.get('sessions') !== 'false';
    await ctx.sleep(400);
    const user = userPart(db.config, DEFAULT_CONFIG as unknown as Record<string, unknown>);
    if (isObject(user.server)) delete user.server.token;
    const { config, redacted } = secrets ? { config: user, redacted: [] as string[] } : redact(user);
    const agents = db.agents.filter((a) => a.source === 'user').map(agentFile);
    const routines: Routine[] = [...db.routines.values()].map((r) => (secrets ? { ...r, webhookSecret: r.webhookSecret ?? `whs_${r.id.replace(/^r_/, '')}_q2JX0mVt9cS4rB7n` } : { ...r, webhookSecret: undefined }));
    const tasks: Task[] = [...db.tasks.values()];
    const memories: MemoryEntry[] = [...db.memories.values()];
    const sessions: Session[] = withSessions ? [...db.sessions.values()] : [];
    const messages: Message[] = withSessions ? sessions.flatMap((s) => db.messages.get(s.id) ?? []) : [];
    const backup: HubBackup = {
      format: 'conclave-backup',
      version: 1,
      createdAt: Date.now(),
      hub: { name: 'madx', version: '0.1.0' },
      includesSecrets: secrets,
      config,
      redacted,
      secretNames: { providers: Object.keys(db.keys), values: [...db.values] },
      ...(secrets ? { secrets: { providers: { ...db.keys }, values: Object.fromEntries(db.values.map((k) => [k, `${k.toLowerCase()}-mock-value`])) } } : {}),
      agents,
      routines,
      tasks,
      memories,
      sessions,
      messages,
      counts: { agents: agents.length, routines: routines.length, tasks: tasks.length, memories: memories.length, sessions: sessions.length, messages: messages.length },
    };
    return backup;
  });

  on('POST', '/api/restore', async ({ query, body }) => {
    if (!isObject(body) || body.format !== 'conclave-backup') return ctx.fail(400, 'This is not a Conclave backup. Pick the .json file that Download a backup saved.');
    if (typeof body.version !== 'number' || body.version > 1) return ctx.fail(400, `This backup is version ${String(body.version)} and this hub reads version 1. Update the hub, then restore again.`);
    const b = body as unknown as HubBackup;
    await ctx.sleep(900);
    const restored = zero();
    const skipped = zero();
    const withConfig = query.get('config') !== '0' && query.get('config') !== 'false';

    let configDone = false;
    if (withConfig && isObject(b.config) && Object.keys(b.config).length) {
      const patch = structuredClone(b.config);
      delete patch.server;
      // through the config route, so a first-run hub keeps it across reloads
      await ctx.request('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
      configDone = true;
    }

    let secrets = 0;
    if (isObject(b.secrets)) {
      for (const [k, v] of Object.entries(b.secrets.providers ?? {})) {
        db.keys[k] = v;
        secrets++;
      }
      for (const k of Object.keys(b.secrets.values ?? {})) {
        if (!db.values.includes(k)) db.values.push(k);
        secrets++;
      }
    }

    // agent files: the file's copy wins, like on the hub
    for (const a of b.agents ?? []) {
      const def = typeof a?.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(a.file) && typeof a.content === 'string' ? fromAgentFile(a.file, a.content) : undefined;
      if (!def) {
        skipped.agents++;
        continue;
      }
      const i = db.agents.findIndex((x) => x.name === def.name);
      if (i >= 0) db.agents[i] = { ...db.agents[i], ...def };
      else db.agents.push(def);
      restored.agents++;
    }

    for (const r of b.routines ?? []) {
      db.routines.set(r.id, { ...r, webhookSecret: r.webhookSecret ?? db.routines.get(r.id)?.webhookSecret ?? ctx.uid('whs') });
      restored.routines++;
    }
    for (const t of b.tasks ?? []) {
      if (db.tasks.has(t.id)) skipped.tasks++;
      else (db.tasks.set(t.id, t), restored.tasks++);
    }
    for (const m of b.memories ?? []) {
      if (db.memories.has(m.id)) skipped.memories++;
      else (db.memories.set(m.id, m), restored.memories++);
    }
    const added = new Set<string>();
    for (const s of b.sessions ?? []) {
      if (db.sessions.has(s.id)) {
        skipped.sessions++;
        continue;
      }
      const live = ['running', 'waiting_approval', 'waiting_input', 'waiting_reset'].includes(s.status);
      db.sessions.set(s.id, { ...s, status: live ? 'idle' : s.status, resumeAt: live ? undefined : s.resumeAt });
      db.messages.set(s.id, []);
      added.add(s.id);
      restored.sessions++;
    }
    for (const m of b.messages ?? []) {
      if (!added.has(m.sessionId)) {
        skipped.messages++;
        continue;
      }
      db.messages.get(m.sessionId)!.push(m);
      restored.messages++;
    }

    const missingKeys = (b.secretNames?.providers ?? []).filter((p) => !db.keys[p]);
    ctx.emit({ type: 'config.updated' });
    // like the hub: a field the file left out is named only when this hub has no value for it
    const valueAt = (obj: unknown, path: string) => path.split('.').reduce<unknown>((cur, k) => (isObject(cur) ? cur[k] : undefined), obj);
    const redacted = b.includesSecrets ? [] : (b.redacted ?? []).filter((path) => valueAt(db.config, path) === undefined);
    const result: RestoreResult = { config: configDone, secrets, restored, skipped, missingKeys, redacted };
    return result;
  });
}
