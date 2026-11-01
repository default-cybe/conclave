/**
 * Text of a file attached to a meeting (POST /api/meetings/:id/files): a
 * resume, a job description, slides. Only the text is kept; it goes into the
 * prep and the context pack. Text files are read the way chat attachments
 * are (UTF-8 with no NUL bytes, providers/common.ts); Office files through
 * tools/office.ts; PDFs through pdftotext on the hub when it is installed.
 */
import { isZip, mediaTypeFor } from '../attachments/limits';
import { redactSecrets } from '../memory/secrets';
import { isTextMediaType } from '../providers/common';
import { OFFICE_EXT, officeToMarkdown } from '../tools/office';
import { MEETING_FILE_TEXT_MAX } from './wire';

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function pdfText(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const p = Bun.spawn(['pdftotext', '-layout', '-', '-'], { stdin: bytes, stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => p.kill(), 30_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 ? out : undefined;
  } catch {
    return undefined; // no pdftotext on the hub
  }
}

/** The file's text (secrets redacted, capped) and a note when some or all of it is missing. */
export async function fileText(name: string, mediaType: string | undefined, bytes: Uint8Array): Promise<{ mediaType: string; text: string; note?: string }> {
  const type = mediaTypeFor(mediaType, name);
  const ext = /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? '';
  let text: string | undefined;
  let note: string | undefined;
  if (type === 'application/pdf' || ext === 'pdf') {
    text = await pdfText(bytes);
    if (text === undefined) note = 'PDF text could not be read (pdftotext is not on the hub). Paste the text as a .txt file.';
    else if (!text.trim()) note = 'The PDF has no text layer (probably scanned).';
  } else if (OFFICE_EXT.has(ext)) {
    try {
      text = officeToMarkdown(ext, bytes);
    } catch {
      note = `The ${ext} file could not be opened.`;
    }
  } else if (isZip(type, name)) {
    note = 'Zips are not opened here: attach the files inside.';
  } else if (isTextMediaType(type) || !bytes.includes(0)) {
    try {
      text = bytes.includes(0) ? undefined : utf8.decode(bytes);
    } catch {
      text = undefined;
    }
    if (text === undefined) note = 'Not a text file.';
  } else note = 'Not a text file.';
  let out = redactSecrets(text ?? '').trim();
  if (out.length > MEETING_FILE_TEXT_MAX) {
    out = out.slice(0, MEETING_FILE_TEXT_MAX);
    note = `Cut to the first ${MEETING_FILE_TEXT_MAX.toLocaleString('en-US')} characters.`;
  }
  return { mediaType: type, text: out, ...(note ? { note } : {}) };
}
