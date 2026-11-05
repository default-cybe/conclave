/** Learnings' quick check and model check guards (assistant/learnings.ts): pastes, one-offs, health by chat title. */
import { describe, expect, test } from 'bun:test';
import { cueOf, parseCheck, proseOf, type Candidate } from '../../src/assistant/learnings';

const cand = (text: string, title = 'Conclave work'): Candidate => ({ sessionId: 's1', seq: 1, text, cue: 'preference', before: '', title, at: 0 });

describe('Learnings guards', () => {
  test('"no, use X" inside a pasted log or code block is not a correction', () => {
    expect(cueOf('why does this fail?\n```\nERROR: no, use --force instead\n```')).toBeUndefined();
    expect(cueOf('see this\n2026-11-05T10:04:44Z WARN no, use the other port\n2026-11-05T10:04:45Z INFO never retry')).toBeUndefined();
    expect(cueOf('> no, use pnpm\nwhat did he mean?')).toBeUndefined();
    // the person's own words around a paste still count
    expect(cueOf('no, use pnpm here, not npm\n```\nnpm ERR! peer dep\n```')).toBe('correction');
    expect(proseOf('fix it\n```\nno, use X\n```')).toBe('fix it');
  });

  test('a one-off instruction for this task is not captured; a remember is', () => {
    expect(cueOf('no, use port 3000 for this test')).toBeUndefined();
    expect(cueOf("actually, skip the lint step for now")).toBeUndefined();
    expect(cueOf('remember: use port 3000 for this test and every time after')).toBe('remember');
    expect(cueOf('no, always use port 3000 for the dev server')).toBe('correction');
  });

  test('a preference in a health chat is dropped by the chat title', () => {
    const reply = JSON.stringify({ items: [{ i: 0, kind: 'preference', fact: 'The user prefers the La Roche-Posay cleanser.', rule: 'Suggest La Roche-Posay.', confidence: 0.9 }] });
    expect(parseCheck(reply, [cand('I prefer the La Roche-Posay one', 'Morning skincare routine')])).toEqual([]);
    expect(parseCheck(reply, [cand('I prefer the La Roche-Posay one', 'Shopping list')])).toHaveLength(1);
  });
});
