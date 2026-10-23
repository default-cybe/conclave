import { afterAll, describe, expect, test } from 'bun:test';
import { mediaTypeFor } from '../../src/attachments/limits';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { DOC_TEXT_MAX_BYTES, MESSAGE_DOCS_MAX_BYTES, documentsForWire } from '../../src/providers/common';
import { GeminiProvider } from '../../src/providers/gemini';
import { OpenAIProvider } from '../../src/providers/openai';
import { OpenAIResponsesProvider } from '../../src/providers/openai-responses';
import { SplitWireProvider } from '../../src/providers/split';
import type { ChatRequest } from '../../src/providers/types';
import type { ContentBlock } from '../../src/types';
import { mockServer, sseResponse } from './mock';

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const PDF = b64('%PDF-1.4 fake');
const ZIP = b64(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3]));

/** What the owner sent: markdown, html, a PDF and a zip (one stored as text/plain, one with no type). */
const docs: ContentBlock[] = [
  { type: 'text', text: 'see these' },
  { type: 'document', mediaType: 'text/markdown', data: b64('# Readme\nhello'), title: '00_README.md' },
  { type: 'document', mediaType: 'text/html', data: b64('<p>prep</p>'), title: 'Prep.html' },
  { type: 'document', mediaType: 'application/pdf', data: PDF, title: 'Prep.pdf' },
  { type: 'document', mediaType: 'text/plain', data: ZIP, title: 'Pack.zip' },
  { type: 'document', mediaType: '', data: ZIP, title: 'Other.zip' },
];

const req = (model: string): ChatRequest => ({ model, system: [], messages: [{ role: 'user', content: docs }], maxTokens: 16 });

const MD = '<document name="00_README.md" type="text/markdown">\n# Readme\nhello\n</document>';
const HTML = '<document name="Prep.html" type="text/html">\n<p>prep</p>\n</document>';
const ZIP1 = '[archive Pack.zip, 9 bytes: not opened]';
const ZIP2 = '[archive Other.zip, 9 bytes: not opened]';
const NO_PDF = '[PDF Prep.pdf not readable by this model]';

const opts = (type: 'anthropic' | 'openai' | 'gemini', baseUrl?: string) => ({ id: 'p', config: { type, ...(baseUrl ? { baseUrl } : {}) }, apiKey: 'k' });

describe('documentsForWire', () => {
  test('text documents are text, PDFs stay when the wire reads them, archives and binaries are notes', () => {
    const out = documentsForWire(docs, true);
    expect(out[0]).toEqual({ type: 'text', text: 'see these' });
    expect(out[1]).toEqual({ type: 'text', text: MD });
    expect(out[2]).toEqual({ type: 'text', text: HTML });
    expect(out[3]).toEqual(docs[3]);
    expect(out[4]).toEqual({ type: 'text', text: ZIP1 });
    expect(out[5]).toEqual({ type: 'text', text: ZIP2 });
    expect(documentsForWire(docs, false)[3]).toEqual({ type: 'text', text: NO_PDF });
    const bin = documentsForWire([{ type: 'document', mediaType: 'application/octet-stream', data: b64(new Uint8Array([0, 1, 2])), title: 'x.bin' }], true);
    expect(bin).toEqual([{ type: 'text', text: '[Attached x.bin (application/octet-stream, 3 bytes): not readable by this model]' }]);
    // text/plain that is not UTF-8 text is never sent as text
    const bad = documentsForWire([{ type: 'document', mediaType: 'text/plain', data: b64(new Uint8Array([0xff, 0xfe, 0x00])), title: 'a.txt' }], true);
    expect((bad[0] as { text: string }).text).toBe('[Attached a.txt (text/plain, 3 bytes): not readable by this model]');
  });

  test('a document is cut at the cap with a note, and the message at its cap', () => {
    const big = 'a'.repeat(DOC_TEXT_MAX_BYTES + 10);
    const [one] = documentsForWire([{ type: 'document', mediaType: 'text/plain', data: b64(big), title: 'big.txt' }], true) as Array<{ text: string }>;
    expect(one.text).toBe(`<document name="big.txt" type="text/plain">\n${'a'.repeat(DOC_TEXT_MAX_BYTES)}\n[truncated after 200 KB]\n</document>`);
    const many = documentsForWire(
      Array.from({ length: 4 }, (_, i): ContentBlock => ({ type: 'document', mediaType: 'text/markdown', data: b64(big), title: `n${i}.md` })),
      true,
    ) as Array<{ text: string }>;
    // 200 + 200 + 112 KB fill the 512 KB; the fourth is a note
    expect(many[2].text).toContain(`[truncated after ${Math.round((MESSAGE_DOCS_MAX_BYTES - 2 * DOC_TEXT_MAX_BYTES) / 1024)} KB]`);
    expect(many[3].text).toBe('[Attached n3.md (text/markdown, 200 KB): left out, this message\'s attachments pass 512 KB of text]');
  });

  test('a cut never splits a character', () => {
    const [d] = documentsForWire([{ type: 'document', mediaType: 'text/plain', data: b64('é'.repeat(DOC_TEXT_MAX_BYTES)), title: 'e.txt' }], true) as Array<{ text: string }>;
    expect(d.text).not.toContain('\uFFFD');
  });

  test('a document with no type takes the type its name gives', () => {
    const [d] = documentsForWire([{ type: 'document', mediaType: 'application/octet-stream', data: b64('# hi'), title: 'notes.md' }], true) as Array<{ text: string }>;
    expect(d.text).toBe('<document name="notes.md" type="text/markdown">\n# hi\n</document>');
  });
});

describe('per wire', () => {
  test('anthropic (and Z.ai on its wire): text as text, PDF native, zips as notes', () => {
    const body = new AnthropicProvider(opts('anthropic', 'https://api.z.ai/api/anthropic')).buildBody(req('glm-5.3')) as any;
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'see these' },
      { type: 'text', text: MD },
      { type: 'text', text: HTML },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'Prep.pdf' },
      { type: 'text', text: ZIP1 },
      { type: 'text', text: ZIP2 },
    ]);
  });

  test('gemini: text as text, PDF inline', () => {
    const body = new GeminiProvider(opts('gemini')).buildBody(req('gemini-3-pro')) as any;
    expect(body.contents[0].parts).toEqual([{ text: 'see these' }, { text: MD }, { text: HTML }, { inlineData: { mimeType: 'application/pdf', data: PDF } }, { text: ZIP1 }, { text: ZIP2 }]);
  });

  test('openai responses: text as input_text, PDF as input_file', () => {
    const body = new OpenAIResponsesProvider(opts('openai')).buildBody(req('gpt-5.5')) as any;
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'see these' },
      { type: 'input_text', text: MD },
      { type: 'input_text', text: HTML },
      { type: 'input_file', filename: 'Prep.pdf', file_data: `data:application/pdf;base64,${PDF}` },
      { type: 'input_text', text: ZIP1 },
      { type: 'input_text', text: ZIP2 },
    ]);
  });

  test('openai chat: PDF as a file part for a vision model, a note for a text-only one', () => {
    const vision = new OpenAIProvider(opts('openai')).buildBody(req('gpt-5.5')) as any;
    expect(vision.messages[0].content).toEqual([
      { type: 'text', text: 'see these' },
      { type: 'text', text: MD },
      { type: 'text', text: HTML },
      { type: 'file', file: { filename: 'Prep.pdf', file_data: `data:application/pdf;base64,${PDF}` } },
      { type: 'text', text: ZIP1 },
      { type: 'text', text: ZIP2 },
    ]);
    const textOnly = new OpenAIProvider(opts('openai', 'https://api.deepseek.com/v1')).buildBody(req('deepseek-chat')) as any;
    // all text: one string, as compatible APIs want
    expect(textOnly.messages[0].content).toBe(['see these', MD, HTML, NO_PDF, ZIP1, ZIP2].join('\n\n'));
  });

  describe('cliproxy split', () => {
    const server = mockServer(() => sseResponse(['data: [DONE]\n\n']));
    afterAll(() => server.stop());

    test('both wires carry the documents', async () => {
      const p = new SplitWireProvider({
        id: 'cliproxy',
        apiKey: 'k',
        config: { type: 'openai', baseUrl: `${server.url}/v1`, anthropicWire: { baseUrl: server.url, models: ['claude-*'] } },
      });
      for (const model of ['claude-opus-5-5', 'gpt-5.5']) {
        try {
          for await (const _ of p.stream(req(model)));
        } catch {
          // the mock answers nothing useful; the request body is what counts
        }
      }
      const [claude, gpt] = server.requests.map((r) => r.body);
      expect(claude.messages[0].content.map((b: any) => b.type)).toEqual(['text', 'text', 'text', 'document', 'text', 'text']);
      expect(claude.messages[0].content[1].text).toBe(MD);
      expect(gpt.messages[0].content.map((b: any) => b.text ?? b.type)).toEqual(['see these', MD, HTML, 'file', ZIP1, ZIP2]);
    });
  });
});

describe('tool results', () => {
  const PNG = b64('png bytes');
  const NO_IMG = '[image (image/png) not readable by this model]';
  /** What Read returns: a text file, an image and a PDF with no text layer, all in one turn. */
  const toolReq = (model: string): ChatRequest => ({
    model,
    system: [],
    maxTokens: 16,
    messages: [
      { role: 'assistant', content: ['a', 'b', 'c'].map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })) },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'a', content: [{ type: 'text', text: 'note:' }, { type: 'document', mediaType: 'text/markdown', data: b64('# Readme\nhello'), title: '00_README.md' }] },
          { type: 'tool_result', toolUseId: 'b', content: [{ type: 'text', text: 'Image x.png' }, { type: 'image', mediaType: 'image/png', data: PNG }] },
          { type: 'tool_result', toolUseId: 'c', content: [{ type: 'text', text: 'PDF p.pdf' }, { type: 'document', mediaType: 'application/pdf', data: PDF, title: 'Prep.pdf' }] },
        ],
      },
    ],
  });

  test('documentsForWire reaches into tool results; images are a note without vision', () => {
    const [res] = documentsForWire([{ type: 'tool_result', toolUseId: 'b', content: [{ type: 'image', mediaType: 'image/png', data: PNG }, { type: 'document', mediaType: 'text/markdown', data: b64('# hi'), title: 'a.md' }] }], false, false);
    expect(res).toEqual({ type: 'tool_result', toolUseId: 'b', content: [{ type: 'text', text: NO_IMG }, { type: 'text', text: '<document name="a.md" type="text/markdown">\n# hi\n</document>' }] });
  });

  test('anthropic wire, text-only GLM on Z.ai: text doc as text, image as a note, PDF native', () => {
    const body = new AnthropicProvider(opts('anthropic', 'https://api.z.ai/api/anthropic')).buildBody(toolReq('glm-5.3')) as any;
    expect(body.messages[1].content.map((r: any) => r.content)).toEqual([
      [{ type: 'text', text: 'note:' }, { type: 'text', text: MD }],
      [{ type: 'text', text: 'Image x.png' }, { type: 'text', text: NO_IMG }],
      [{ type: 'text', text: 'PDF p.pdf' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'Prep.pdf' }],
    ]);
    // a Claude model sees the image
    const claude = new AnthropicProvider(opts('anthropic')).buildBody(toolReq('claude-sonnet-5-5')) as any;
    expect(claude.messages[1].content[1].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
  });

  test('openai chat, text-only model: notes in the tool messages, no user message of media', () => {
    const body = new OpenAIProvider(opts('openai', 'https://api.deepseek.com/v1')).buildBody(toolReq('deepseek-chat')) as any;
    expect(body.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'a', content: `note:\n${MD}` },
      { role: 'tool', tool_call_id: 'b', content: `Image x.png\n${NO_IMG}` },
      { role: 'tool', tool_call_id: 'c', content: `PDF p.pdf\n${NO_PDF}` },
    ]);
  });

  test('openai chat, vision model: the image and the PDF follow in a user message', () => {
    const body = new OpenAIProvider(opts('openai')).buildBody(toolReq('gpt-5.5')) as any;
    expect(body.messages.at(-1).content.map((p: any) => p.type)).toEqual(['text', 'image_url', 'text', 'file']);
  });

  test('openai responses: the image and the PDF ride in their function_call_output; an unknown model keeps its image', () => {
    for (const model of ['gpt-5.5', 'gpt-6-sol']) {
      const body = new OpenAIResponsesProvider(opts('openai')).buildBody(toolReq(model)) as any;
      expect(body.input.filter((i: any) => i.type === 'message')).toEqual([]);
      const out = body.input.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.output);
      expect(out[0]).toBe(`note:\n${MD}`);
      expect(out[1]).toEqual([
        { type: 'input_text', text: 'Image x.png' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' },
      ]);
      expect(out[2]).toEqual([
        { type: 'input_text', text: 'PDF p.pdf' },
        { type: 'input_file', filename: 'Prep.pdf', file_data: `data:application/pdf;base64,${PDF}` },
      ]);
    }
  });

  test('gemini: functionResponse text, then the image and PDF inline', () => {
    const body = new GeminiProvider(opts('gemini')).buildBody(toolReq('gemini-3-flash')) as any;
    const parts = body.contents.at(-1).parts;
    expect(parts[0].functionResponse.response).toEqual({ output: `note:\n${MD}` });
    expect(parts.slice(3)).toEqual([
      { text: 'Images returned by Read:' },
      { inlineData: { mimeType: 'image/png', data: PNG } },
      { text: 'Images returned by Read:' },
      { inlineData: { mimeType: 'application/pdf', data: PDF } },
    ]);
  });
});

describe('mediaTypeFor', () => {
  test('an empty or generic browser type takes the extension', () => {
    expect(mediaTypeFor('', 'Pack.zip')).toBe('application/zip');
    expect(mediaTypeFor('', 'README.md')).toBe('text/markdown');
    expect(mediaTypeFor('application/octet-stream', 'notes.MD')).toBe('text/markdown');
    expect(mediaTypeFor('video/mp2t', 'a.ts')).toBe('text/x-typescript');
  });

  test('a real type stays; an unknown name is octet-stream', () => {
    expect(mediaTypeFor('text/plain', 'Pack.zip')).toBe('text/plain');
    expect(mediaTypeFor('image/png', 'x.png')).toBe('image/png');
    expect(mediaTypeFor('', 'x.constructor')).toBe('application/octet-stream');
    expect(mediaTypeFor(undefined, undefined)).toBe('application/octet-stream');
  });
});
