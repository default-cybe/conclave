import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ReadTool } from '../../src/tools/read';
import { officeToMarkdown } from '../../src/tools/office';
import { fakeHost, makeCtx, makeSession, tempDir, text } from './helpers';

/** A zip archive of the given entries (deflated), as Word, Excel and LibreOffice write them. */
function zip(entries: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const raw = Buffer.from(body);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const crc = Bun.hash.crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(h, n, data);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(central.length / 2, 8);
  e.writeUInt16LE(central.length / 2, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, e]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PKG = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const wp = (t: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(t)}</w:p>`;
const li = (t: string, lvl = 0) => wp(t, `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="1"/></w:numPr>`);
const tc = (t: string) => `<w:tc>${wp(t)}</w:tc>`;

function docx(body: string): Uint8Array {
  return zip({
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    // a localized style id: the heading level comes from the name
    'word/styles.xml': `<w:styles ${W}><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  });
}

const DOCX = docx(
  wp('Quarterly report', '<w:pStyle w:val="berschrift1"/>') +
    wp('Revenue grew &amp; costs fell.') +
    wp('Details', '<w:pStyle w:val="Heading2"/>') +
    li('first point') +
    li('nested point', 1) +
    `<w:tbl><w:tr>${tc('Region')}${tc('Sales')}</w:tr><w:tr>${tc('EU | West')}${tc('42')}</w:tr></w:tbl>` +
    `<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del></w:p>`,
);

function xlsx(extraRows = 0): Uint8Array {
  const rows = Array.from({ length: extraRows }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  return zip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Long" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships ${PKG}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Rent</t></r><r><t xml:space="preserve"> (office)</t></r></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Paid</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c><c r="C2" t="b"><v>1</v></c></row><row r="3"><c r="B3"><f>SUM(B2)</f><v>1250.5</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
  });
}

const sp = (t: string, ph = '') => `<p:sp><p:nvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slide = (inner: string) => `<p:sld ${P}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

const PPTX = zip({
  'ppt/presentation.xml': `<p:presentation ${P} ${R}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships ${PKG}><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': slide(sp('Launch plan', 'title') + sp('Ship in March') + sp('1', 'sldNum')),
  'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${PKG}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  'ppt/notesSlides/notesSlide1.xml': `<p:notes ${P}><p:cSld><p:spTree>${sp('Mention the beta', 'body')}${sp('1', 'sldNum')}</p:spTree></p:cSld></p:notes>`,
  'ppt/slides/slide2.xml': slide(
    `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Goal</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Beta</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  ),
});

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';
const odf = (body: string) => zip({ mimetype: 'application/vnd.oasis.opendocument', 'content.xml': `<office:document-content ${ODF_NS}><office:body>${body}</office:body></office:document-content>` });

let dir = '';
let cleanup = () => {};
beforeAll(() => {
  ({ dir, cleanup } = tempDir());
});
afterAll(() => cleanup());
const file = (name: string, data: Uint8Array | string) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

describe('Read Office files', () => {
  test('docx: headings, paragraphs, lists and tables as Markdown', async () => {
    const out = await ReadTool.run({ file_path: file('report.docx', DOCX) }, makeCtx({ cwd: dir }));
    expect(out.isError).toBeFalsy();
    const t = text(out);
    expect(t).toContain('# Quarterly report');
    expect(t).toContain('Revenue grew & costs fell.');
    expect(t).toContain('## Details');
    expect(t).toMatch(/- first point\n\s+\d+\t {2}- nested point/);
    expect(t).toContain('| Region | Sales |');
    expect(t).toContain('| --- | --- |');
    expect(t).toContain('| EU \\| West | 42 |');
    expect(t).toContain('kept');
    expect(t).not.toContain('deleted words');
    // no read mark: Write must not take the zip for a text file it read
    expect(out.meta?.readMark).toBeUndefined();
  });

  test('docx pages with offset and limit', async () => {
    const out = await ReadTool.run({ file_path: file('paged.docx', DOCX), offset: 5, limit: 1 }, makeCtx({ cwd: dir }));
    expect(text(out)).toContain('5\t## Details');
    expect(text(out)).not.toContain('Quarterly');
    expect(text(out)).toContain('Use offset and limit to read more');
  });

  test('xlsx: each sheet as a table, shared and inline strings, booleans; long sheets capped with a note', async () => {
    const t = text(await ReadTool.run({ file_path: file('budget.xlsx', xlsx(503)) }, makeCtx({ cwd: dir })));
    expect(t).toContain('## Sheet: Budget');
    expect(t).toContain('| Item | Cost | Paid |');
    expect(t).toContain('| Rent (office) | 1250.5 | TRUE |');
    expect(t).toContain('|  | 1250.5 |  |');
    expect(t).toContain('## Sheet: Long');
    expect(t).toContain('| 498 |');
    expect(t).not.toContain('| 500 |');
    expect(t).toContain('This sheet has 503 rows; only the first 500 are shown');
  });

  test('xlsx: a huge cell column from the file is bounded (XFD across 2000 rows, ZZZZZZ past Excel max)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="XFD${i + 1}"><v>1</v></c></row>`).join('');
    const sheet = (data: string) =>
      zip({
        'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships ${PKG}><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
      });
    const start = performance.now();
    const t = officeToMarkdown('xlsx', sheet(rows));
    expect(t).toContain('| 0 |');
    expect(t).toContain('This sheet has 2000 rows; only the first 500 are shown');
    expect(t).toContain('only the first 200 columns are shown');
    expect(t.length).toBeLessThan(50_000);
    const t2 = officeToMarkdown('xlsx', sheet('<row r="1"><c r="A1"><v>ok</v></c><c r="ZZZZZZ1"><v>bad</v></c></row>'));
    expect(t2).toContain('| ok |');
    expect(t2).not.toContain('bad');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test('ods: repeat counts are capped per sheet, not per element', async () => {
    const cells = '<table:table-cell table:number-columns-repeated="1000"><text:p>v</text:p></table:table-cell>'.repeat(5);
    const rows = `<table:table-row table:number-rows-repeated="1000">${cells}</table:table-row>`.repeat(5);
    const huge = '<table:table-row table:number-rows-repeated="1000000000"><table:table-cell table:number-columns-repeated="1000000000"><text:p>w</text:p></table:table-cell></table:table-row>';
    const start = performance.now();
    const t = officeToMarkdown('ods', odf(`<office:spreadsheet><table:table table:name="R">${rows}${huge}</table:table></office:spreadsheet>`));
    expect(t).toContain('This sheet has 1000005000 rows; only the first 500 are shown');
    expect(t).toContain('only the first 200 columns are shown');
    const header = t.split('\n').find((l) => l.includes('| v |')) ?? '';
    expect(header.split(' | ').length).toBe(200);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test('pptx: a section per slide with title, text, tables and notes; slide numbers left out', async () => {
    const t = text(await ReadTool.run({ file_path: file('deck.pptx', PPTX) }, makeCtx({ cwd: dir })));
    expect(t).toContain('## Slide 1');
    expect(t).toContain('### Launch plan');
    expect(t).toContain('Ship in March');
    expect(t).toMatch(/Notes:\n\s*\d+\tMention the beta/);
    expect(t).toContain('## Slide 2');
    expect(t).toContain('| Q1 | Beta |');
    expect(t.indexOf('Slide 1')).toBeLessThan(t.indexOf('Slide 2'));
    expect(t).not.toMatch(/\t1$/m);
  });

  test('odt, ods and odp', async () => {
    const odt = odf(
      `<office:text><text:h text:outline-level="2">Intro</text:h><text:p>Hello<text:s text:c="2"/>world</text:p><text:list><text:list-item><text:p>one</text:p><text:list><text:list-item><text:p>inner</text:p></text:list-item></text:list></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></office:text>`,
    );
    const t1 = text(await ReadTool.run({ file_path: file('n.odt', odt) }, makeCtx({ cwd: dir })));
    expect(t1).toContain('## Intro');
    expect(t1).toContain('Hello  world');
    expect(t1).toMatch(/- one\n\s+\d+\t {2}- inner/);
    expect(t1).toContain('| a | b |');

    const ods = odf(
      `<office:spreadsheet><table:table table:name="Data"><table:table-row><table:table-cell><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>y</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row><table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet>`,
    );
    const t2 = text(await ReadTool.run({ file_path: file('s.ods', ods) }, makeCtx({ cwd: dir })));
    expect(t2).toContain('## Sheet: Data');
    expect(t2).toContain('| x | y | y |');
    expect(t2.split('\n').length).toBeLessThan(10);

    const odp = odf(
      `<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Agenda</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>say hi</text:p></draw:text-box></draw:frame></presentation:notes></draw:page><draw:page><draw:frame><draw:text-box><text:p>Next</text:p></draw:text-box></draw:frame></draw:page></office:presentation>`,
    );
    const t3 = text(await ReadTool.run({ file_path: file('p.odp', odp) }, makeCtx({ cwd: dir })));
    expect(t3).toMatch(/## Slide 1\n\s*\d+\t\n\s*\d+\tAgenda/);
    expect(t3).toMatch(/Notes:\n\s*\d+\tsay hi/);
    expect(t3).toContain('## Slide 2');
  });

  test('legacy .doc stays refused with a conversion hint; a broken docx says why', async () => {
    const legacy = await ReadTool.run({ file_path: file('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])) }, makeCtx({ cwd: dir }));
    expect(legacy.isError).toBe(true);
    expect(text(legacy)).toContain('legacy binary Office file (.doc)');
    expect(text(legacy)).toContain('soffice --headless --convert-to docx');
    const broken = await ReadTool.run({ file_path: file('broken.docx', 'not a zip at all') }, makeCtx({ cwd: dir }));
    expect(broken.isError).toBe(true);
    expect(text(broken)).toContain('not a zip archive');
  });
});

describe('Read with a Docling server', () => {
  let server: ReturnType<typeof Bun.serve>;
  const calls: Array<{ path: string; name: string; formats: string[]; pages: string[] }> = [];
  let mode: 'ok' | 'fail' | 'hang' = 'ok';
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const f = form.get('files') as File;
        calls.push({ path: new URL(req.url).pathname, name: f.name, formats: form.getAll('to_formats') as string[], pages: form.getAll('page_range') as string[] });
        if (mode === 'fail') return new Response('model load failed', { status: 500 });
        if (mode === 'hang') await new Promise((r) => req.signal.addEventListener('abort', r));
        return Response.json({ document: { md_content: `# From Docling\n\n| a | b |\n| --- | --- |\n| ${f.size} | x |` }, status: 'success' });
      },
    });
  });
  afterAll(() => server.stop(true));
  afterEach(() => {
    calls.length = 0;
    mode = 'ok';
  });
  const host = () => fakeHost({ cfg: { documents: { docling: { url: `http://127.0.0.1:${server.port}/` } } } });

  test('Office files go to docling-serve and its Markdown comes back', async () => {
    const out = await ReadTool.run({ file_path: file('d.docx', DOCX) }, makeCtx({ cwd: dir, host: host() }));
    expect(text(out)).toContain('# From Docling');
    expect(calls).toEqual([{ path: '/v1/convert/file', name: 'd.docx', formats: ['md'], pages: [] }]);
  });

  test('a failing server falls back to the built-in reader and says so', async () => {
    mode = 'fail';
    const out = await ReadTool.run({ file_path: file('e.docx', DOCX) }, makeCtx({ cwd: dir, host: host() }));
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain('# Quarterly report');
    expect(text(out)).toContain('Docling failed (HTTP 500 model load failed)');
  });

  test('aborting during the Docling call stops the read instead of falling back', async () => {
    mode = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(ReadTool.run({ file_path: file('h.docx', DOCX) }, makeCtx({ cwd: dir, host: host(), signal: ac.signal }))).rejects.toThrow();
  });

  test('a PDF without a text layer goes to Docling with the page range', async () => {
    const out = await ReadTool.run({ file_path: file('scan.pdf', '%PDF-1.4 no text layer'), pages: '2-3' }, makeCtx({ cwd: dir, host: host() }));
    expect(text(out)).toContain('converted by Docling');
    expect(text(out)).toContain('# From Docling');
    expect(calls[0].pages).toEqual(['2', '3']);
  });

  test("a member's session uses the stateless Docling server too", async () => {
    const ctx = makeCtx({ cwd: dir, host: host() });
    ctx.session = makeSession(dir, { accountId: 'acct_friend' });
    expect(text(await ReadTool.run({ file_path: file('m.docx', DOCX) }, ctx))).toContain('# From Docling');
    expect(calls.length).toBe(1);
  });

  test('odt or a non-http URL never goes', async () => {
    await ReadTool.run({ file_path: file('o.odt', odf('<office:text><text:p>hi</text:p></office:text>')) }, makeCtx({ cwd: dir, host: host() }));
    const ftp = fakeHost({ cfg: { documents: { docling: { url: `ftp://127.0.0.1:${server.port}/` } } } });
    expect(text(await ReadTool.run({ file_path: file('f.docx', DOCX) }, makeCtx({ cwd: dir, host: ftp })))).toContain('# Quarterly report');
    expect(calls).toEqual([]);
  });
});
