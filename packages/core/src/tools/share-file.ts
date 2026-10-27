/**
 * ShareFile: hand a file the session made to the owner as a file card
 * (files/share.ts). The model gets one line; the result's meta.file is what
 * the clients draw, and GET /api/sessions/:id/files/:toolUseId serves the
 * bytes after checking the path again. Untrusted agents never get it
 * (UNTRUSTED_DENY): a web page must not put files in front of the owner.
 */
import { isAbsolute, resolve } from 'node:path';
import { usesOutputs } from '../files/share';
import type { Tool } from './types';
import { fail } from './util';

export interface ShareFileInput {
  path: string;
  title?: string;
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const ShareFileTool: Tool<ShareFileInput> = {
  name: 'ShareFile',
  description: `Give the owner a file you made, as a file card they can open and download in the chat. Save the file first (Write; RenderFile for a PDF or PNG from HTML, SVG or Markdown; or Bash for binary files such as DOCX or ZIP), then call ShareFile with its path.

Use it when the owner asks for a whole file: a complete program, a full source, config or document file, or a chart or graph saved as a PNG or SVG image. Give the file a fitting name and extension, then reply in a few lines instead of pasting the whole file. Keep short commands, diffs and small examples inline. The owner has the file only once this tool returns a card; do not say a file is shared or attached before that.

- path: the file. A relative path is read from the session folder, or from the outputs folder when the session has none.
- title: optional words for the card.

Only files in the session folder, the outputs folder, or the folder of a job you delegated can be shared, at most 30 MB each.`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, title: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: true,
  timeoutMs: 30_000,
  summarize: (i) => `Share ${String(i.path ?? '').split('/').pop()}`,
  async run(input, ctx) {
    if (!ctx.host.shareCheck) return fail('Sharing files is not available here.');
    const raw = String(input.path ?? '').trim();
    if (!raw) return fail('Give the path of the file to share.');
    const base = usesOutputs(ctx.session) && ctx.host.outputsDir ? ctx.host.outputsDir() : undefined;
    const abs = base && !isAbsolute(raw) && !raw.startsWith('~') ? resolve(base, raw) : ctx.machine.resolve(raw, ctx.cwd);
    const check = await ctx.host.shareCheck(abs);
    if (!check.ok) return fail(check.message, { code: `SHARE_${check.code.toUpperCase()}` });
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : undefined;
    return {
      content: `Shared ${check.file.name} (${sizeText(check.file.size)}) with the owner as a file card.`,
      meta: { file: { ...check.file, ...(title ? { title } : {}) } },
    };
  },
};
