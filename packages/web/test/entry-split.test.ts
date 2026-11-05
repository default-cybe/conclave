/**
 * The chat is the first screen, so what it imports statically ships in the
 * entry bundle. The Extensions tabs (MCP servers, Hooks, Skills: about
 * 115 KB) load when their sheet opens, not with the chat.
 *
 *   bun test packages/web/test/entry-split.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const file = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const STATIC = /^import [^;]*from '@\/features\/extensions\/(McpServers|Hooks|Skills)';/m;

describe('entry split', () => {
  test('chat sheets and the context panel import no Extensions tab statically', () => {
    for (const p of ['features/chat/sheets/SessionSheets.tsx', 'features/chat/sheets/Connectors.tsx', 'features/chat/ContextPanel.tsx']) expect(file(p)).not.toMatch(STATIC);
    expect(file('features/chat/sheets/SessionSheets.tsx')).toContain("lazy(() => import('@/features/extensions/Hooks')");
    expect(file('features/chat/sheets/Connectors.tsx')).toContain("lazy(() => import('@/features/extensions/McpServers')");
  });
});
