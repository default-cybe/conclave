import { describe, expect, test } from 'bun:test';
import { coerceInput, validateInput } from '../../src/tools/types';
import { MultiEditTool } from '../../src/tools/multiedit';
import { toolByName } from '../../src/tools';

/** Strings that spell the expected type are read as that type, as Claude Code does. */
describe('coerceInput', () => {
  const schema = MultiEditTool.inputSchema;

  test('MultiEdit edits sent as a JSON string become the array', () => {
    const edits = [{ old_string: 'two', new_string: 'dos' }];
    const { input, coerced } = coerceInput(schema, { file_path: '/x/a.ts', edits: JSON.stringify(edits) });
    expect(coerced).toEqual(['edits']);
    expect((input as { edits: unknown }).edits).toEqual(edits);
    expect(validateInput(schema, input)).toBeUndefined();
  });

  test('edits as a string that is not a JSON array keeps the strict error', () => {
    for (const bad of ['not json', '{"old_string":"a","new_string":"b"}', '"[1]"', '']) {
      const { input, coerced } = coerceInput(schema, { file_path: '/x/a.ts', edits: bad });
      expect(coerced).toEqual([]);
      expect(validateInput(schema, input)).toBe('Parameter edits must be array, got string');
    }
  });

  test('booleans and numbers from strings; other strings stay strings', () => {
    const edit = toolByName('Edit')!.inputSchema;
    const read = toolByName('Read')!.inputSchema;
    expect(coerceInput(edit, { file_path: '/a', old_string: 'true', new_string: '1', replace_all: 'true' }).input).toEqual({ file_path: '/a', old_string: 'true', new_string: '1', replace_all: true });
    expect(coerceInput(edit, { file_path: '/a', old_string: 'a', new_string: 'b', replace_all: 'yes' }).coerced).toEqual([]);
    // limit is an integer, so "2.5" stays a string and fails validation
    expect(coerceInput(read, { file_path: '/a', offset: ' 10 ', limit: '2.5' }).input).toEqual({ file_path: '/a', offset: 10, limit: '2.5' });
    expect(validateInput(read, coerceInput(read, { file_path: '/a', limit: '2.5' }).input)).toContain('limit');
    expect(coerceInput(read, { file_path: '/a', offset: '1e3x' }).coerced).toEqual([]);
  });

  test('an object parameter sent as a JSON string becomes the object; an input that is not an object is left alone', () => {
    const s = { type: 'object', properties: { opts: { type: 'object' } } };
    expect(coerceInput(s, { opts: '{"a":1}' }).input).toEqual({ opts: { a: 1 } });
    expect(coerceInput(s, { opts: '[1]' }).coerced).toEqual([]);
    expect(coerceInput(s, 'raw').input).toBe('raw');
  });
});
