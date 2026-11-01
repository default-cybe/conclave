/**
 * The typed half of the workflow launch form (features/workflows/args-form):
 * a preset's args fill the declared fields and keep the rest as extras, and
 * the form's values build the args object back (empty fields left out,
 * numbers parsed, extras merged). Rendering: one input or checkbox per
 * declared arg, with the description as help.
 *
 *   bun test packages/web/test/args-form.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkflowArgFieldDto } from '@conclave/core/client';
import { ArgsForm, argsFromValues, valuesFromArgs } from '../src/features/workflows/args-form';

const schema: Record<string, WorkflowArgFieldDto> = {
  question: { type: 'string', description: 'what to ask' },
  votes: { type: 'number' },
  fast: { type: 'boolean' },
};

describe('values from a preset', () => {
  test('declared keys fill their field, others come back as extras', () => {
    const { values, extras } = valuesFromArgs(schema, { question: 'Caddy?', votes: 3, fast: false, worktreeFrom: 7 });
    expect(values).toEqual({ question: 'Caddy?', votes: '3', fast: false });
    expect(extras).toEqual({ worktreeFrom: 7 });
  });

  test('nulls and missing keys become empty fields', () => {
    const { values, extras } = valuesFromArgs(schema, { question: null });
    expect(values).toEqual({ question: '' });
    expect(extras).toEqual({});
  });
});

describe('args from the form', () => {
  test('filled fields typed, empty left out, extras merged', () => {
    const { args, error } = argsFromValues(schema, { question: ' Caddy? ', votes: '3', fast: true }, { worktreeFrom: 7 });
    expect(error).toBeUndefined();
    expect(args).toEqual({ worktreeFrom: 7, question: 'Caddy?', votes: 3, fast: true });
  });

  test('a declared boolean is always sent, false included; empty strings are left out, a bad number says why', () => {
    expect(argsFromValues(schema, { question: '', fast: false }).args).toEqual({ fast: false });
    expect(argsFromValues(schema, { votes: 'lots' }).error).toContain('votes');
  });
});

describe('the form renders one control per declared arg', () => {
  test('a text input with help, a number input, and a checkbox', () => {
    const out = renderToStaticMarkup(<ArgsForm schema={schema} values={{ question: 'Caddy?' }} set={() => {}} />);
    expect(out).toContain('what to ask');
    expect(out.match(/<input /g)?.length).toBe(3);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('value="Caddy?"');
  });
});
