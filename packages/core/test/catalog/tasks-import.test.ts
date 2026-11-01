/**
 * agentic-tools-mcp import (docs/design/ECOSYSTEM.md 1.10) from files in a
 * temp folder, through the hub's LocalMachine. Also the MCP manager changes
 * the catalog needs: the stdio env allowlist.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { LocalMachine } from '../../src/machine/local';
import { importAgenticTools, mapPriority, type TaskImportHost } from '../../src/catalog/tasks-import';
import { stdioEnv, MCP_ENV_ALLOW } from '../../src/extensions/mcp';
import type { Task } from '../../src/types';
import type { MemoryInput } from '../../src/memory/types';
import { cleanupAll, tmp, write } from './helpers';

afterEach(cleanupAll);

function host() {
  const tasks: Task[] = [];
  const memories: MemoryInput[] = [];
  let imported = new Set<string>();
  const m = new LocalMachine();
  const h: TaskImportHost = {
    machine: (d) => (d === 'local' ? m : undefined),
    tasks: () => tasks,
    createTask: (t) => {
      const task = { id: `t${tasks.length}`, description: '', status: 'todo', priority: 1, labels: [], createdAt: 0, updatedAt: 0, ...t } as Task;
      tasks.push(task);
      return task;
    },
    saveMemory: async (x) => void memories.push(x),
    importedMemories: () => imported,
    rememberImported: (ids) => (imported = new Set([...imported, ...ids])),
  };
  return { h, tasks, memories };
}

function project(): string {
  const dir = tmp('agentic-');
  write(
    join(dir, '.agentic-tools-mcp/tasks/tasks.json'),
    JSON.stringify({
      projects: [{ id: 'p1', name: 'thesis', description: '' }],
      tasks: [
        { id: 'a', name: 'Write intro', details: 'Two pages', projectId: 'p1', completed: false, status: 'in-progress', priority: 9, tags: ['uni'], complexity: 3, createdAt: '', updatedAt: '' },
        { id: 'b', name: 'Find sources', details: '', projectId: 'p1', parentId: 'a', completed: false, status: 'blocked', priority: 5, dependsOn: ['c'], createdAt: '', updatedAt: '' },
        { id: 'c', name: 'Ask advisor', details: '', projectId: 'p1', completed: true, status: 'done', createdAt: '', updatedAt: '' },
      ],
      subtasks: [{ id: 's1', name: 'Old subtask', details: '', taskId: 'a', projectId: 'p1', completed: false, createdAt: '', updatedAt: '' }],
      migration: { version: '1.7.0' },
    }),
  );
  write(join(dir, '.agentic-tools-mcp/memories/preferences/editor.json'), JSON.stringify({ id: 'm1', title: 'Editor', content: 'Uses helix with the default keymap', metadata: {}, category: 'preferences', createdAt: '', updatedAt: '' }));
  write(join(dir, '.agentic-tools-mcp/memories/general/empty.json'), JSON.stringify({ id: 'm2', title: 'Empty', content: '' }));
  return dir;
}

describe('agentic-tools import', () => {
  test('dry run maps status, priority, tags, links and the project', async () => {
    const { h, tasks } = host();
    const r = await importAgenticTools(h, { from: 'agentic-tools-mcp', path: project(), dryRun: true });
    expect(r).toMatchObject({ projects: 1, tasks: 4, memories: 1 });
    expect(tasks.length).toBe(0);
    const [a, b, c, s1] = r.preview!;
    expect(a).toMatchObject({ title: 'Write intro', status: 'doing', priority: 3, labels: ['uni'], project: 'thesis', meta: { sourceId: 'a', complexity: 3 } });
    expect(b).toMatchObject({ status: 'todo', priority: 1, labels: ['blocked'], meta: { parentId: 'a', dependsOn: ['c'] } });
    expect(c.status).toBe('done');
    expect(s1.meta.parentId).toBe('a');
    expect(r.skipped).toEqual(['memory empty.json: empty']);
  });

  test('a real import writes tasks and fact memories once', async () => {
    const { h, tasks, memories } = host();
    const dir = project();
    await importAgenticTools(h, { from: 'agentic-tools-mcp', path: dir });
    expect(tasks.length).toBe(4);
    expect(memories).toEqual([{ content: 'Editor: Uses helix with the default keymap', kind: 'fact', tags: ['agentic-tools', 'preferences'] }]);
    const again = await importAgenticTools(h, { from: 'agentic-tools-mcp', path: dir });
    expect(again).toMatchObject({ tasks: 0, memories: 0 });
    expect(tasks.length).toBe(4);
  });

  test('priority mapping and errors', async () => {
    expect([undefined, 1, 5, 6, 8, 9, 10].map(mapPriority)).toEqual([0, 1, 1, 2, 2, 3, 3]);
    const { h } = host();
    await expect(importAgenticTools(h, { from: 'agentic-tools-mcp', path: '/x', device: 'pve' })).rejects.toMatchObject({ status: 404 });
    const r = await importAgenticTools(h, { from: 'agentic-tools-mcp', path: tmp('empty-'), dryRun: true });
    expect(r.tasks).toBe(0);
    expect(r.skipped[0]).toContain('not found');
  });
});

describe('MCP stdio env', () => {
  test('only the allowlist plus the server env reach a stdio server, unless inheritEnv is set', () => {
    const base = { PATH: '/bin', HOME: '/root', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa', LANG: 'C' };
    const env = stdioEnv({}, { TOKEN: 'x' }, base);
    expect(env).toEqual({ PATH: '/bin', HOME: '/root', LANG: 'C', TOKEN: 'x' });
    expect(Object.keys(env).every((k) => MCP_ENV_ALLOW.includes(k) || k === 'TOKEN')).toBe(true);
    expect(stdioEnv({ inheritEnv: true }, undefined, base).ANTHROPIC_API_KEY).toBe('sk-ant');
  });
});
