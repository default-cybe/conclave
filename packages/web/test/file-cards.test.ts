/**
 * File cards (features/files/words.ts) and the Outputs card picking up
 * ShareFile results (features/chat/panel.ts), so a file Bash made shows too.
 */
import { describe, expect, test } from 'bun:test';
import type { Message } from '@conclave/core/types';
import { fileCardOf, fileFacts, previewOf, shareCards, sizeWords } from '../src/features/files/words';
import { sessionOutputs } from '../src/features/chat/panel';

const file = { path: '/home/kai/out/report.pdf', device: 'local', name: 'report.pdf', mediaType: 'application/pdf', size: 14_540 };

describe('fileCardOf', () => {
  test('reads meta.file with the call id; an error or a malformed card is none', () => {
    expect(fileCardOf({ toolUseId: 'toolu_1', meta: { file } })).toEqual({ toolUseId: 'toolu_1', name: 'report.pdf', mediaType: 'application/pdf', size: 14_540 });
    expect(fileCardOf({ toolUseId: 'toolu_1', meta: { file: { ...file, title: 'Q3 report' } } })?.title).toBe('Q3 report');
    expect(fileCardOf({ toolUseId: 'toolu_1', meta: { file }, isError: true })).toBeUndefined();
    expect(fileCardOf({ toolUseId: 'toolu_1', meta: { file: { name: 'x' } } })).toBeUndefined();
    expect(fileCardOf({ meta: { file } })).toBeUndefined();
    expect(fileCardOf(undefined)).toBeUndefined();
  });

  test('only a ShareFile call makes a card; meta.file on another tool is ignored', () => {
    const result = { toolUseId: 'toolu_1', meta: { file } };
    expect(shareCards([{ name: 'ShareFile', result }]).map((c) => c.name)).toEqual(['report.pdf']);
    expect(shareCards([{ name: 'Bash', result }, { name: 'WebFetch', result: { ...result, toolUseId: 'toolu_2' } }, { name: 'ShareFile' }])).toEqual([]);
  });

  test('words and previews: SVG and HTML never preview', () => {
    expect(fileFacts(file)).toBe('PDF, 14.2 KB');
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(previewOf('application/pdf')).toBe('pdf');
    expect(previewOf('image/png')).toBe('image');
    expect(previewOf('text/csv')).toBe('text');
    expect(previewOf('image/svg+xml')).toBeUndefined();
    expect(previewOf('text/html')).toBeUndefined();
  });
});

describe('Outputs', () => {
  test('a ShareFile result is a file row; a Write of the same file keeps its preview', () => {
    const at = (n: number) => 1000 + n;
    const msgs = [
      { id: 'm1', sessionId: 's', seq: 1, role: 'assistant', createdAt: at(1), content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'python3 make_pdf.py' } }] },
      { id: 'm2', sessionId: 's', seq: 2, role: 'user', createdAt: at(2), content: [{ type: 'tool_result', toolUseId: 'b1', content: 'ok' }] },
      { id: 'm3', sessionId: 's', seq: 3, role: 'assistant', createdAt: at(3), content: [{ type: 'tool_use', id: 's1', name: 'ShareFile', input: { path: 'report.pdf' } }] },
      { id: 'm4', sessionId: 's', seq: 4, role: 'user', createdAt: at(4), content: [{ type: 'tool_result', toolUseId: 's1', content: 'Shared report.pdf', meta: { file } }] },
      { id: 'm5', sessionId: 's', seq: 5, role: 'assistant', createdAt: at(5), content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/home/kai/out/notes.md', content: '# hi' } }] },
      { id: 'm6', sessionId: 's', seq: 6, role: 'user', createdAt: at(6), content: [{ type: 'tool_result', toolUseId: 'w1', content: 'ok' }] },
      { id: 'm7', sessionId: 's', seq: 7, role: 'assistant', createdAt: at(7), content: [{ type: 'tool_use', id: 's2', name: 'ShareFile', input: { path: 'notes.md' } }] },
      { id: 'm8', sessionId: 's', seq: 8, role: 'user', createdAt: at(8), content: [{ type: 'tool_result', toolUseId: 's2', content: 'Shared', meta: { file: { ...file, path: '/home/kai/out/notes.md', name: 'notes.md' } } }] },
      { id: 'm9', sessionId: 's', seq: 9, role: 'user', createdAt: at(9), content: [{ type: 'tool_result', toolUseId: 's3', content: 'Refused', isError: true, meta: { file } }] },
      // a non-ShareFile tool whose result carries meta.file is not a shared file
      { id: 'm10', sessionId: 's', seq: 10, role: 'assistant', createdAt: at(10), content: [{ type: 'tool_use', id: 'x1', name: 'WebFetch', input: { url: 'https://x' } }] },
      { id: 'm11', sessionId: 's', seq: 11, role: 'user', createdAt: at(11), content: [{ type: 'tool_result', toolUseId: 'x1', content: 'page', meta: { file: { ...file, path: '/home/kai/.ssh/id_ed25519', name: 'id_ed25519' } } }] },
    ] as unknown as Message[];
    const list = sessionOutputs(msgs);
    expect(list.map((o) => [o.label, o.toolUseId, o.content])).toEqual([
      ['notes.md', 's2', '# hi'],
      ['report.pdf', 's1', undefined],
    ]);
  });
});
