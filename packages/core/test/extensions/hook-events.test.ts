import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_EVENT_DOCS } from '../../src/extensions/hook-events';
import { FIRED_HOOK_EVENTS, HOOK_EVENTS } from '../../src/engine/settings-sources';

const src = (p: string) => readFileSync(join(import.meta.dir, '../../src', p), 'utf8');
const runner = src('extensions/hooks.ts');
// where the engine fires hooks: engine.runHook(session, '<Event>', ...)
const FIRING = ['session/runner.ts', 'session/compaction.ts', 'engine/subagent.ts', 'engine/engine.ts', 'engine/commands.ts'].map(src).join('\n');

/** The expression hooks.ts reads a stdout field with: json.x at the top, h.x in hookSpecificOutput, d.x in its decision object. */
function readerOf(field: string): string {
  const parts = field.split('.');
  const leaf = parts[parts.length - 1];
  if (parts[0] !== 'hookSpecificOutput') return `json.${leaf}`;
  return parts[1] === 'decision' && parts.length > 2 ? `d.${leaf}` : `h.${leaf}`;
}

/** The HookOutcome property the runner turns a stdout field into (applyJsonOutput, applyBehavior). */
const OUTCOME: Record<string, string[]> = {
  decision: ['blocked', 'permissionDecision'],
  reason: ['reason'],
  additionalContext: ['additionalContext'],
  systemMessage: ['systemMessages'],
  continue: ['stop'],
  stopReason: ['stop'],
  permissionDecision: ['permissionDecision', 'blocked'],
  permissionDecisionReason: ['reason'],
  updatedInput: ['updatedInput'],
  updatedToolOutput: ['updatedToolOutput'],
  behavior: ['permissionDecision', 'blocked'],
  message: ['reason'],
};

/** The variable a firing site keeps the event's outcome in: `const pre = await engine.runHook(session, 'PreToolUse', ...)`. */
function outcomeVar(ev: string): string | undefined {
  const re = new RegExp(`const (\\w+) = await engine\\.runHook\\([\\s\\S]{0,120}?'${ev}'`);
  return re.exec(FIRING)?.[1];
}

describe('hook event docs', () => {
  test('one entry per event core knows, and no other', () => {
    expect(Object.keys(HOOK_EVENT_DOCS).sort()).toEqual([...HOOK_EVENTS].sort());
  });

  test('every documented event is fired by the engine', () => {
    for (const ev of Object.keys(HOOK_EVENT_DOCS)) {
      expect(FIRED_HOOK_EVENTS.has(ev as never)).toBe(true);
      expect(FIRING.includes(`'${ev}'`)).toBe(true);
    }
  });

  test('every listed stdout field is read by the runner', () => {
    for (const [ev, doc] of Object.entries(HOOK_EVENT_DOCS))
      for (const { field } of doc.stdout) {
        const reader = readerOf(field);
        if (!runner.includes(reader)) throw new Error(`${ev}: ${field} is listed, but hooks.ts never reads ${reader}`);
      }
  });

  test('the firing site uses what each listed stdout field turns into', () => {
    for (const [ev, doc] of Object.entries(HOOK_EVENT_DOCS)) {
      if (!doc.stdout.length) continue;
      const v = outcomeVar(ev);
      if (!v) throw new Error(`${ev}: no "const x = await engine.runHook(..., '${ev}')" found`);
      for (const { field } of doc.stdout) {
        const leaf = field.split('.').pop()!;
        const props = OUTCOME[leaf];
        if (!props) throw new Error(`${ev}: ${field} has no known outcome property`);
        if (!props.some((p) => FIRING.includes(`${v}.${p}`))) throw new Error(`${ev}: ${field} is listed, but the caller never reads ${v}.${props.join(' or ')}`);
      }
    }
  });

  test('plain stdout is listed only where the runner adds it to context', () => {
    const m = /STDOUT_IS_CONTEXT = new Set<HookEvent>\(\[([^\]]*)\]\)/.exec(runner);
    const plain = [...(m?.[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
    expect(plain.length).toBeGreaterThan(0);
    expect(Object.entries(HOOK_EVENT_DOCS).filter(([, d]) => d.plainStdout).map(([e]) => e).sort()).toEqual(plain);
  });
});
