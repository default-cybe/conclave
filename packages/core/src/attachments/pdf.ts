/**
 * A PDF the model API cannot open. Anthropic takes a PDF document block only
 * when it can parse the file: an encrypted or password-protected one, a
 * damaged one, or a file named .pdf that is something else makes it answer
 * 400 "The PDF specified was not valid", and every later turn that resends it
 * fails the same way. So the hub checks the bytes when a file is attached
 * (attachments/prepare.ts) and stores its text instead; documentsForWire
 * (providers/common.ts) checks again before a request and sends a note in its
 * place; a PDF the API still refuses is replaced by the runner's recovery
 * (session/bad-image.ts dropPdf).
 */

/** `%PDF-` must start within this many bytes (readers allow junk before the header up to 1 KB). */
const PDF_MAGIC_WITHIN = 1024;
/** pdftotext output kept at most, in bytes; the wire cuts documents shorter still (providers/common.ts DOC_TEXT_MAX_BYTES). */
const PDF_TEXT_MAX = 256 * 1024;

/**
 * Why a model API would refuse these bytes as a PDF, by a cheap look with no
 * parsing: 'not a PDF file', 'encrypted', or undefined when they look fine.
 */
export function pdfProblem(bytes: Uint8Array): string | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.subarray(0, PDF_MAGIC_WITHIN).indexOf('%PDF-') < 0) return 'not a PDF file';
  // the trailer or the xref stream's dictionary names the encryption dictionary: "/Encrypt 12 0 R" or "/Encrypt <<"
  for (let at = buf.indexOf('/Encrypt'); at >= 0; at = buf.indexOf('/Encrypt', at + 8)) {
    if (/^\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(buf.toString('latin1', at, at + 40))) return 'encrypted';
  }
  return undefined;
}

/**
 * pdftotext's text of a PDF; undefined when it could not open the file, null
 * when the hub has no pdftotext. `firstPage` reads page 1 only, as a check.
 * The output stops at PDF_TEXT_MAX bytes: a small PDF can expand to gigabytes.
 */
export async function pdftotext(bytes: Uint8Array, firstPage = false): Promise<string | undefined | null> {
  let p;
  try {
    p = Bun.spawn(['pdftotext', ...(firstPage ? ['-l', '1'] : []), '-layout', '-', '-'], { stdin: bytes, stdout: 'pipe', stderr: 'ignore', env: process.env });
  } catch {
    return null; // no pdftotext on the hub
  }
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = p.stdout.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      const chunk = r.value;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= PDF_TEXT_MAX) {
        p.kill();
        return Buffer.concat(chunks).subarray(0, PDF_TEXT_MAX).toString('utf8');
      }
    }
    return (await p.exited) === 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The note for a PDF that could not be sent and whose text could not be read. */
export function pdfLeftOutNote(name: string, why: string): string {
  return `[${name} could not be sent as a PDF (${why}) and no text could be read from it]`;
}

/** What goes to the model in place of a PDF it cannot open: a note and its text, or the note alone. */
export async function pdfAsText(name: string, bytes: Uint8Array, why: string): Promise<string> {
  const text = (await pdftotext(bytes))?.trim();
  return text ? `[${name} could not be sent as a PDF (${why}); its text follows]\n${text}` : pdfLeftOutNote(name, why);
}

/** The attach-time check: why a PDF cannot go as a PDF, or undefined. With pdftotext on the hub, it must open page 1 too. */
export async function checkPdf(bytes: Uint8Array): Promise<string | undefined> {
  return pdfProblem(bytes) ?? ((await pdftotext(bytes, true)) === undefined ? 'damaged' : undefined);
}
