/**
 * Per-model harness parity: the ten things an agent does in Conclave (call a
 * tool, delegate, run a workflow, find a tool with ToolSearch, read a file,
 * read an image, read a PDF, open a zip, answer in a schema, read a text
 * attachment), checked for each model on its own wire. No model is called:
 * each provider adapter runs against a fake upstream that answers in that
 * vendor's wire format, and the check reads what the adapter sent and what it
 * parsed back. The conversation goes through the hub's real transcript build
 * (session/transcript.ts), so a model without vision gets what the hub's
 * transcription step stores (session/image-text.ts), stubbed here.
 *
 * What it proves: the harness gives every model the same tools, inputs and
 * results Claude gets, and reads every model's calls back. What it cannot
 * prove: that the model then uses them well. That needs real-model runs
 * (bench/bench.ts with a non-Claude model), which this check does not make.
 *
 *   bun bench/checks/model-parity.ts          # the support table, markdown
 *   bun bench/checks/model-parity.ts --json
 */
import { createProvider } from '../../packages/core/src/providers/registry';
import type { ChatRequest, Provider, StreamEvent, ToolSpec } from '../../packages/core/src/providers/types';
import type { ProviderConfig } from '../../packages/core/src/config/schema';
import type { ContentBlock, Message, ToolUseBlock } from '../../packages/core/src/types';
import { buildProviderMessages, imageKey } from '../../packages/core/src/session/transcript';
import { prepareAttachments } from '../../packages/core/src/attachments/prepare';
import { DelegateTool } from '../../packages/core/src/tools/delegate';
import { WorkflowTool } from '../../packages/core/src/tools/workflow';
import { ToolSearchTool } from '../../packages/core/src/tools/tool-search';
import { toolByName } from '../../packages/core/src/tools/index';
import { makeZip, PNG } from '../../packages/core/test/attachments/zipkit';

export type Wire = 'anthropic' | 'chat' | 'responses' | 'gemini';

export interface Target {
  label: string;
  wire: Wire;
  provider: string;
  model: string;
  config: ProviderConfig;
  /** The catalog says it reads images and PDFs itself; otherwise the hub transcribes them first. */
  vision: boolean;
}

export const TARGETS: Target[] = [
  { label: 'Claude Opus 5.5', wire: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', config: { type: 'anthropic', apiKey: 'k' }, vision: true },
  { label: 'GPT-5.5 (Chat Completions)', wire: 'chat', provider: 'openai', model: 'gpt-5.5', config: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }, vision: true },
  { label: 'GPT-5.5 (Responses)', wire: 'responses', provider: 'openai', model: 'gpt-5.5', config: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', responsesApi: true }, vision: true },
  { label: 'Gemini 3.1 Pro', wire: 'gemini', provider: 'google', model: 'gemini-3.1-pro-preview', config: { type: 'gemini', apiKey: 'k' }, vision: true },
  { label: 'Gemini 3 Flash', wire: 'gemini', provider: 'google', model: 'gemini-3-flash-preview', config: { type: 'gemini', apiKey: 'k' }, vision: true },
  { label: 'Gemini 3 Flash (Chat Completions gateway)', wire: 'chat', provider: 'cliproxy', model: 'gemini-3-flash-preview', config: { type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'k' }, vision: true },
  { label: 'GLM-5.3 (Z.ai Coding Plan)', wire: 'chat', provider: 'zai', model: 'glm-5.3', config: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'k' }, vision: false },
  { label: 'GLM-5.3 Flash (Z.ai Coding Plan)', wire: 'chat', provider: 'zai', model: 'glm-5.3-flash', config: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'k' }, vision: true },
];

export const CASES = ['tool call', 'delegate', 'workflow', 'ToolSearch', 'read file', 'image', 'PDF', 'unzip', 'structured output', 'attachment'] as const;
export type Case = (typeof CASES)[number];

export interface CaseResult {
  ok: boolean;
  /** Why it failed, one line. */
  why?: string;
}

// ---------------------------------------------------------------------------
// The fake upstream: one scripted answer per request, in the target's wire format
// ---------------------------------------------------------------------------

type Answer = { call: { index: number; args: Record<string, unknown> } } | { text: string };

/** A signature the fake hands out with a call, so a check can see it come back. */
export const CALL_SIGNATURE = 'parity-sig-1';

const enc = (events: unknown[], named = false) =>
  new Response(events.map((e) => (typeof e === 'string' ? `data: ${e}\n\n` : `${named ? `event: ${(e as { type: string }).type}\n` : ''}data: ${JSON.stringify(e)}\n\n`)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** The tool names a request offers, in order, as that wire spells them. */
function wireToolNames(wire: Wire, body: any): string[] {
  if (wire === 'gemini') return (body.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).map((f: any) => f.name);
  if (wire === 'chat') return (body.tools ?? []).map((t: any) => t.function?.name);
  return (body.tools ?? []).map((t: any) => t.name);
}

function answer(wire: Wire, body: any, a: Answer): Response {
  const call = 'call' in a ? { name: wireToolNames(wire, body)[a.call.index], args: a.call.args } : undefined;
  const text = 'text' in a ? a.text : '';
  switch (wire) {
    case 'anthropic': {
      const block = call ? { type: 'tool_use', id: 'toolu_p1', name: call.name, input: {} } : { type: 'text', text: '' };
      const delta = call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text };
      return enc(
        [
          { type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: block },
          { type: 'content_block_delta', index: 0, delta },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ],
        true,
      );
    }
    case 'chat': {
      const delta = call
        ? { tool_calls: [{ index: 0, id: 'call_p1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) }, extra_content: { google: { thought_signature: CALL_SIGNATURE } } }] }
        : { content: text };
      return enc([{ id: 'c1', model: body.model, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] }, '[DONE]']);
    }
    case 'responses': {
      const item = call
        ? { type: 'function_call', id: 'fc_1', call_id: 'call_p1', name: call.name, arguments: JSON.stringify(call.args) }
        : { type: 'message', id: 'm_1', role: 'assistant', content: [{ type: 'output_text', text }] };
      return enc(
        [
          { type: 'response.created', response: { id: 'r1', model: body.model } },
          { type: 'response.output_item.added', output_index: 0, item: call ? item : { ...item, content: [] } },
          ...(call ? [] : [{ type: 'response.output_text.delta', output_index: 0, item_id: 'm_1', delta: text }]),
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } },
        ],
        true,
      );
    }
    case 'gemini': {
      const part = call ? { functionCall: { name: call.name, args: call.args }, thoughtSignature: CALL_SIGNATURE } : { text };
      return enc([{ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]);
    }
  }
}

/** One request through the target's adapter: what it sent and what it parsed. */
async function roundTrip(t: Target, req: Omit<ChatRequest, 'model'>, a: Answer): Promise<{ body: any; content: ContentBlock[] }> {
  let body: any;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return answer(t.wire, body, a);
  };
  const p = createProvider(t.provider, t.config, { apiKey: 'k', fetch }) as Provider;
  let done: Extract<StreamEvent, { type: 'done' }> | undefined;
  for await (const ev of p.stream({ ...req, model: t.model })) if (ev.type === 'done') done = ev;
  return { body, content: done?.content ?? [] };
}

// ---------------------------------------------------------------------------
// The conversation as the hub stores it, and as it builds it for a request
// ---------------------------------------------------------------------------

let seq = 0;
const msg = (role: 'user' | 'assistant', content: ContentBlock[], model?: string): Message =>
  ({ id: `m${++seq}`, sessionId: 's', seq, role, kind: 'normal', content, createdAt: 0, ...(model ? { model } : {}) }) as Message;

/** What session/image-text.ts stores for a model without vision: a transcription per image or PDF, by its key. */
export const transcriptionOf = (key: string) => `[transcribed ${key.slice(0, 8)}: PARITY-OCR]`;

function withTranscriptions(m: Message): Message {
  const texts: Record<string, string> = {};
  const media = (b: ContentBlock) => (b.type === 'image' || (b.type === 'document' && b.mediaType === 'application/pdf') ? [b] : []);
  for (const b of m.content) {
    const inner = b.type === 'tool_result' && typeof b.content !== 'string' ? b.content.flatMap(media) : media(b);
    for (const x of inner) texts[imageKey(x as never)] = transcriptionOf(imageKey(x as never));
  }
  return Object.keys(texts).length ? { ...m, meta: { ...m.meta, imageText: texts } } : m;
}

function request(t: Target, stored: Message[], tools: ToolSpec[], extra: Partial<ChatRequest> = {}): Omit<ChatRequest, 'model'> {
  const messages = buildProviderMessages(t.vision ? stored : stored.map(withTranscriptions), {
    modelRef: `${t.provider}/${t.model}`,
    toolNames: new Set(tools.map((x) => x.name)),
    cache: false,
    imageText: !t.vision,
  });
  return { system: [{ text: 'You are a parity check.' }], messages, tools, ...extra };
}

const spec = (name: string, description = name, inputSchema: any = { type: 'object', properties: { x: { type: 'string' } } }): ToolSpec => ({ name, description, inputSchema });
const real = (name: string): ToolSpec => {
  const tool = toolByName(name) ?? [DelegateTool, WorkflowTool, ToolSearchTool].find((x) => x.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
};

/** Every string in a wire body, so a check can find text wherever the wire put it. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}
const carries = (body: unknown, text: string) => strings(body).some((s) => s.includes(text));

/** An object in the body that holds both the needle text and a reference to the call (its id, or its name on Gemini). */
function paired(body: unknown, needle: string, ref: string[]): boolean {
  const walk = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const own = Object.values(v as object);
    if (own.some((x) => typeof x === 'string' && ref.includes(x)) && carries(v, needle)) return true;
    return own.some(walk);
  };
  return walk(body);
}

const fail = (why: string): CaseResult => ({ ok: false, why });
const pass: CaseResult = { ok: true };

function firstCall(content: ContentBlock[]): ToolUseBlock | undefined {
  return content.find((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Ask for a call to tools[index] with args; check it parses back to the original name and the same input. */
async function callCase(t: Target, tools: ToolSpec[], index: number, args: Record<string, unknown>, check?: (body: any) => string | undefined): Promise<{ result: CaseResult; call?: ToolUseBlock; content?: ContentBlock[] }> {
  const stored = [msg('user', [{ type: 'text', text: 'Go.' }])];
  const { body, content } = await roundTrip(t, request(t, stored, tools), { call: { index, args } });
  const offered = wireToolNames(t.wire, body);
  if (offered.length !== tools.length) return { result: fail(`${offered.length} of ${tools.length} tools offered`) };
  const why = check?.(body);
  if (why) return { result: fail(why) };
  const call = firstCall(content);
  if (!call) return { result: fail('no tool call parsed') };
  if (call.name !== tools[index].name) return { result: fail(`call parsed as ${call.name}`) };
  if (JSON.stringify(call.input) !== JSON.stringify(args)) return { result: fail('call input changed') };
  return { result: pass, call, content };
}

/** The wire schema of a tool keeps its required parameters. */
function keepsRequired(t: Target, body: any, index: number, required: string[]): string | undefined {
  const decl =
    t.wire === 'gemini'
      ? (body.tools ?? []).flatMap((x: any) => x.functionDeclarations ?? [])[index]?.parameters
      : t.wire === 'chat'
        ? body.tools?.[index]?.function?.parameters
        : t.wire === 'responses'
          ? body.tools?.[index]?.parameters
          : body.tools?.[index]?.input_schema;
  const have: string[] = decl?.required ?? [];
  const lost = required.filter((r) => !have.includes(r));
  return lost.length ? `schema lost required ${lost.join(', ')}` : undefined;
}

// ---------------------------------------------------------------------------
// The ten cases
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');
const PNG_B64 = Buffer.from(PNG).toString('base64');

/** Text a Z.ai or any other wire must pass on byte for byte: non-ASCII, CRLF, tabs, markup and a long body. */
export const ATTACHMENT_TEXT = `naïve café 日本語 — “quotes” 🙂\r\nline\twith\ttabs\n<b>markup</b> & {"json": true}\n${'0123456789abcdef'.repeat(4096)}\nEND-OF-ATTACHMENT`;

export const RUNS: Record<Case, (t: Target) => Promise<CaseResult>> = {
  'tool call': async (t) => {
    // the call, then its result sent back next turn: paired with the call, and on Gemini 3 with its thought signature
    const tools = [real('Bash'), real('Read')];
    const first = await callCase(t, tools, 0, { command: 'echo hi', description: 'Say hi' });
    if (!first.call) return first.result;
    const stored = [
      msg('user', [{ type: 'text', text: 'Go.' }]),
      msg('assistant', first.content!, `${t.provider}/${t.model}`),
      msg('user', [{ type: 'tool_result', toolUseId: first.call.id, content: 'hi-PARITY' }]),
    ];
    const { body } = await roundTrip(t, request(t, stored, tools), { text: 'done' });
    if (!paired(body, 'hi-PARITY', [first.call.id, 'Bash'])) return fail('tool result not paired with its call');
    if (/^gemini-3/.test(t.model) && !carries(body, CALL_SIGNATURE)) return fail('Gemini 3 thought signature not sent back with the call');
    return pass;
  },
  delegate: async (t) => {
    const tools = [real('Bash'), real('Delegate'), real('Task')];
    const r = await callCase(t, tools, 1, { to: 'laptop', prompt: 'Run the tests' }, (b) => keepsRequired(t, b, 1, ['to', 'prompt']) ?? keepsRequired(t, b, 2, (tools[2].inputSchema.required as string[]) ?? []));
    return r.result;
  },
  workflow: async (t) => {
    const script = "export const meta = { name: 'p', description: 'd', phases: [{ title: 'a' }] };\nconst r = await agent('say \"hi\"\\n');\nreturn r;";
    return (await callCase(t, [real('Bash'), real('Workflow')], 1, { script })).result;
  },
  ToolSearch: async (t) => {
    // ToolSearch itself, then the loaded MCP tool whose name no wire takes as it is
    const mcp = spec('mcp__github-enterprise-cloud-instance__create_pull_request_review_comment.v2', 'Comment on a pull request');
    const search = await callCase(t, [real('Bash'), real('ToolSearch')], 1, { query: 'select:' + mcp.name });
    if (!search.result.ok) return search.result;
    return (await callCase(t, [real('Bash'), real('ToolSearch'), mcp], 2, { x: 'LGTM' })).result;
  },
  'read file': async (t) => {
    const call: ToolUseBlock = { type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: 'notes.txt' } };
    const stored = [
      msg('user', [{ type: 'text', text: 'Read notes.txt' }]),
      msg('assistant', [call], 'other/model'),
      msg('user', [{ type: 'tool_result', toolUseId: call.id, content: '1\talpha\n2\tREAD-PARITY' }]),
    ];
    const { body } = await roundTrip(t, request(t, stored, [real('Read')]), { text: 'ok' });
    return paired(body, 'READ-PARITY', [call.id, 'Read']) ? pass : fail('file contents not paired with the Read call');
  },
  image: async (t) => {
    // an attached picture and one a tool returned (Read on a .png)
    const call: ToolUseBlock = { type: 'tool_use', id: 'toolu_img1', name: 'Read', input: { file_path: 'shot.png' } };
    const tool = new Uint8Array([...PNG, 1]);
    const toolB64 = Buffer.from(tool).toString('base64');
    const stored = [
      msg('user', [{ type: 'text', text: 'What is in these?' }, { type: 'image', mediaType: 'image/png', data: PNG_B64 }]),
      msg('assistant', [call], 'other/model'),
      msg('user', [{ type: 'tool_result', toolUseId: call.id, content: [{ type: 'image', mediaType: 'image/png', data: toolB64 }] }]),
    ];
    const { body } = await roundTrip(t, request(t, stored, [real('Read')]), { text: 'ok' });
    if (t.vision) {
      if (!carries(body, PNG_B64)) return fail('attached image not sent');
      return carries(body, toolB64) ? pass : fail('tool-returned image not sent');
    }
    for (const b64 of [PNG_B64, toolB64]) {
      const key = imageKey({ type: 'image', mediaType: 'image/png', data: b64 });
      if (!carries(body, transcriptionOf(key))) return fail(b64 === PNG_B64 ? 'attached image not transcribed' : 'tool-returned image not transcribed');
    }
    return pass;
  },
  PDF: async (t) => {
    const doc: ContentBlock = { type: 'document', mediaType: 'application/pdf', data: PDF, title: 'report.pdf' };
    const stored = [msg('user', [{ type: 'text', text: 'Summarize.' }, doc])];
    const { body } = await roundTrip(t, request(t, stored, [real('Read')]), { text: 'ok' });
    if (t.vision) return carries(body, PDF) ? pass : fail('PDF not sent');
    const key = imageKey(doc as never);
    return carries(body, transcriptionOf(key)) ? pass : fail(carries(body, 'not readable by this model') ? 'PDF sent as "not readable"' : 'PDF missing');
  },
  unzip: async (t) => {
    // a chat with no file tools: the hub opens the zip and the model gets its text and pictures
    const zip = makeZip([
      { name: 'src/main.py', data: 'print("ZIP-PARITY")\n', method: 8 },
      { name: 'shot.png', data: PNG },
    ]);
    const prepared = await prepareAttachments([{ mediaType: 'application/zip', data: Buffer.from(zip).toString('base64'), name: 'project.zip' }], {
      fileTools: () => false,
      save: async () => '',
      read: async () => new Uint8Array(),
    });
    const list = prepared.attachments;
    const blocks: ContentBlock[] = (list ?? []).map((a) =>
      a.mediaType.startsWith('image/') ? { type: 'image', mediaType: a.mediaType, data: a.data! } : { type: 'document', mediaType: a.mediaType, data: a.data, title: a.name },
    );
    const stored = [msg('user', [{ type: 'text', text: 'What is in here?' }, ...blocks])];
    const { body } = await roundTrip(t, request(t, stored, []), { text: 'ok' });
    if (!carries(body, 'print("ZIP-PARITY")')) return fail('zip text file not sent');
    if (t.vision) return carries(body, PNG_B64) ? pass : fail('zip picture not sent');
    const key = imageKey({ type: 'image', mediaType: 'image/png', data: PNG_B64 });
    return carries(body, transcriptionOf(key)) ? pass : fail('zip picture not transcribed');
  },
  'structured output': async (t) => {
    // a schema-constrained answer (responseSchema), and the StructuredOutput tool a workflow step ends with
    const schema = { type: 'object', properties: { parity_answer: { type: 'string' } }, required: ['parity_answer'] };
    const json = '{"parity_answer":"42"}';
    const stored = [msg('user', [{ type: 'text', text: 'Answer.' }])];
    const { body, content } = await roundTrip(t, request(t, stored, [], { responseSchema: schema }), { text: json });
    if (!carries(body, 'parity_answer') && !JSON.stringify(body).includes('parity_answer')) return fail('schema not sent');
    const text = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    if (text !== json) return fail('JSON answer changed');
    const so = spec('StructuredOutput', 'Return the result', schema);
    return (await callCase(t, [real('Bash'), so], 1, { parity_answer: '42' }, (b) => keepsRequired(t, b, 1, ['parity_answer']))).result;
  },
  attachment: async (t) => {
    const doc: ContentBlock = { type: 'document', mediaType: 'text/plain', data: Buffer.from(ATTACHMENT_TEXT, 'utf8').toString('base64'), title: 'notes.txt' };
    const stored = [msg('user', [{ type: 'text', text: 'Read the attachment.' }, doc])];
    const { body } = await roundTrip(t, request(t, stored, [real('Read')]), { text: 'ok' });
    return carries(body, ATTACHMENT_TEXT) ? pass : fail('text attachment not sent byte for byte');
  },
};

export async function runParity(targets = TARGETS): Promise<Array<{ target: Target; results: Record<Case, CaseResult> }>> {
  const out = [];
  for (const target of targets) {
    const results = {} as Record<Case, CaseResult>;
    for (const c of CASES) {
      try {
        results[c] = await RUNS[c](target);
      } catch (err) {
        results[c] = fail(`threw: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    out.push({ target, results });
  }
  return out;
}

export function parityTable(rows: Awaited<ReturnType<typeof runParity>>): string {
  const head = `| Model | ${CASES.join(' | ')} |\n|---|${CASES.map(() => '---').join('|')}|`;
  const lines = rows.map(({ target, results }) => `| ${target.label} | ${CASES.map((c) => (results[c].ok ? 'yes' : 'NO')).join(' | ')} |`);
  const fails = rows.flatMap(({ target, results }) => CASES.filter((c) => !results[c].ok).map((c) => `- ${target.label}, ${c}: ${results[c].why}`));
  return [head, ...lines, '', fails.length ? `Failures:\n${fails.join('\n')}` : 'No failures.'].join('\n');
}

if (import.meta.main) {
  const rows = await runParity();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows.map((r) => ({ model: r.target.label, ...r.results })), null, 2));
  else console.log(parityTable(rows));
  process.exit(rows.every((r) => CASES.every((c) => r.results[c].ok)) ? 0 : 1);
}
