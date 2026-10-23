/** An assistant service on a real database, memory and routines, with no model and no background jobs. */
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { ConfigStore } from '../../src/config';
import { SqliteMemory } from '../../src/memory/store';
import type { ExternalMemory, ExternalNote } from '../../src/memory/external';
import { JobScheduler } from '../../src/scheduler/scheduler';
import { Routines } from '../../src/scheduler/routines';
import { AssistantService } from '../../src/assistant';
import { newId } from '../../src/util/ids';
import type { Task } from '../../src/types';
import { tempHome } from '../memory/helpers';

/** A memory connection that keeps what it is sent. */
export class FakeConnection implements ExternalMemory {
  readonly name = 'notes';
  notes: ExternalNote[] = [];
  mode: 'mirror' | 'external' | undefined = 'mirror';
  writeMode() {
    return this.mode;
  }
  async search() {
    return [];
  }
  async write(note: ExternalNote) {
    this.notes.push(note);
  }
}

export function makeAssistant(opts: { now?: () => number; external?: ExternalMemory; hubZone?: string; memoryOn?: boolean; defaultAgent?: string; untrustedAgent?: (name: string) => boolean } = {}) {
  const home = tempHome();
  const config = new ConfigStore(home.dir, { memory: { enabled: opts.memoryOn ?? true, autoExtract: false, autoInject: true, injectLimit: 6 } } as never);
  const db = openDb(':memory:');
  const bus = new EventBus();
  const repos = new Repos(db);
  const now = opts.now ?? Date.now;
  const memory = new SqliteMemory({ db, bus, config, complete: async () => '{}', external: opts.external, now });
  const scheduler = new JobScheduler({ repos });
  const runs: string[] = [];
  const routines = new Routines({ repos, bus, scheduler, run: async (r) => (runs.push(r.id), { sessionId: '' }), now, ...(opts.defaultAgent ? { defaultAgent: opts.defaultAgent } : {}) });
  const sent: Array<{ sessionId: string; text: string }> = [];
  const createTask = (input: { title: string; description?: string; due?: number; labels?: string[] }): Task => {
    const t: Task = { id: newId('task'), title: input.title, description: input.description ?? '', status: 'todo', priority: 1, due: input.due, labels: input.labels ?? [], createdAt: now(), updatedAt: now() };
    repos.tasks.upsert(t);
    return t;
  };
  const assistant = new AssistantService({
    db,
    kv: repos.kv,
    repos,
    memory,
    routines,
    createTask,
    send: async (sessionId, text) => void sent.push({ sessionId, text }),
    now,
    hubZone: () => opts.hubZone ?? 'Europe/Berlin',
    ...(opts.untrustedAgent ? { untrustedAgent: opts.untrustedAgent } : {}),
  });
  return { assistant, memory, repos, routines, scheduler, db, bus, config, createTask, runs, sent, cleanup: () => (scheduler.stop(), db.close(), home.cleanup()) };
}
