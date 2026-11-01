import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ConclaveConfig } from '../../src/config/schema';
import { LocalMachine } from '../../src/machine/local';
import type { Machine } from '../../src/machine/types';
import type { MemoryEntry, Notice, QuestionRequest, Session, Todo } from '../../src/types';
import type { Tool, ToolContext, ToolHost, ToolOutput } from '../../src/tools/types';

export interface FakeHost extends ToolHost {
  todos: Map<string, Todo[]>;
  outputs: Map<string, string>;
  notices: Array<Omit<Notice, 'id' | 'createdAt'>>;
  modes: Record<string, Session['permissionMode']>;
  completions: Array<{ model?: string; system?: string; prompt: string }>;
  subagents: Array<{ agent: string; prompt: string; model?: string }>;
  memories: MemoryEntry[];
  questions: QuestionRequest['questions'][];
}

export function fakeHost(over: Partial<ToolHost> & { cfg?: Partial<ConclaveConfig> } = {}): FakeHost {
  const cfg: ConclaveConfig = { ...structuredClone(DEFAULT_CONFIG), ...(over.cfg ?? {}) };
  let outputSeq = 0;
  let memSeq = 0;
  const host: FakeHost = {
    todos: new Map(),
    outputs: new Map(),
    notices: [],
    modes: {},
    completions: [],
    subagents: [],
    memories: [],
    questions: [],
    config: () => cfg,
    async runSubagent(opts) {
      host.subagents.push({ agent: opts.agent, prompt: opts.prompt, model: opts.model });
      return { sessionId: 'sub_1', text: `done: ${opts.description}` };
    },
    async askUser(_sid, questions) {
      host.questions.push(questions);
      return Object.fromEntries(questions.map((q) => [q.question, q.options[0].label]));
    },
    async complete(opts) {
      host.completions.push({ model: opts.model, system: opts.system, prompt: opts.prompt });
      return `answer from ${opts.model}`;
    },
    memory: {
      async search(query) {
        return host.memories.filter((m) => m.content.toLowerCase().includes(query.toLowerCase())).map((m) => ({ ...m, score: 1 }));
      },
      async save(entry) {
        const now = Date.now();
        const m: MemoryEntry = {
          id: `mem_${++memSeq}`,
          scope: entry.scope ?? 'global',
          scopeKey: entry.scopeKey,
          kind: entry.kind ?? 'fact',
          content: entry.content,
          tags: entry.tags ?? [],
          importance: 0.5,
          createdAt: now,
          updatedAt: now,
          useCount: 0,
        };
        host.memories.push(m);
        return m;
      },
      async remove(id) {
        const i = host.memories.findIndex((m) => m.id === id);
        if (i === -1) return false;
        host.memories.splice(i, 1);
        return true;
      },
    },
    setTodos(sid, todos) {
      host.todos.set(sid, todos);
    },
    getTodos(sid) {
      return host.todos.get(sid) ?? [];
    },
    async notify(n) {
      host.notices.push(n);
    },
    saveOutput(_sid, _tool, content) {
      const id = `out_${++outputSeq}`;
      host.outputs.set(id, content);
      return id;
    },
    readOutput(id) {
      return host.outputs.get(id);
    },
    async loadSkill(name) {
      if (name !== 'demo') return undefined;
      return { name: 'demo', body: 'Do the demo with $ARGUMENTS.', dir: '/skills/demo' };
    },
    async listSkills() {
      return [
        { name: 'demo', description: 'Run the demo with flair.' },
        { name: 'pack:pdf-merge', description: 'Merge PDF files into one document.', plugin: 'pack' },
        { name: 'pack:csv-clean', description: 'Clean messy CSV tables.', plugin: 'pack' },
      ];
    },
    async createRoutine(input) {
      return { id: `rt_${input.name}`, nextRunAt: Date.now() + 60_000 };
    },
    setPermissionMode(sid, mode) {
      host.modes[sid] = mode;
    },
    audit() {},
  };
  const { cfg: _ignored, ...rest } = over;
  return Object.assign(host, rest);
}

export function makeSession(cwd: string, over: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: 'sess_test',
    title: 'test session',
    agent: 'assistant',
    model: 'test/model',
    mode: 'agent',
    permissionMode: 'default',
    cwd,
    device: 'local',
    status: 'running',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...over,
  };
}

export function makeCtx(opts: { cwd: string; machine?: Machine; host?: FakeHost; depth?: number; readState?: Map<string, number>; sessionId?: string; signal?: AbortSignal }): ToolContext & { progressLog: string[] } {
  const progressLog: string[] = [];
  const sessionId = opts.sessionId ?? 'sess_test';
  return {
    sessionId,
    session: makeSession(opts.cwd, { id: sessionId }),
    cwd: opts.cwd,
    machine: opts.machine ?? new LocalMachine(),
    host: opts.host ?? fakeHost(),
    signal: opts.signal ?? new AbortController().signal,
    model: 'test/model',
    agent: 'assistant',
    depth: opts.depth ?? 0,
    readState: opts.readState ?? new Map(),
    progress: (t) => progressLog.push(t),
    toolUseId: 'toolu_test',
    progressLog,
  };
}

export function tempDir(prefix = 'conclave-tools-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function text(out: ToolOutput): string {
  if (typeof out.content === 'string') return out.content;
  return out.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

export async function run<I>(tool: Tool<I>, input: I, ctx: ToolContext): Promise<ToolOutput> {
  return tool.run(input, ctx);
}

export const hasRg = !!Bun.which('rg');
