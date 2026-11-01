/**
 * One provider id over several wires. A gateway such as CLIProxyAPI serves
 * Claude models on the Anthropic Messages wire (/v1/messages), GPT models on
 * the Responses wire (/v1/responses), Gemini models on the native Gemini wire
 * (/v1beta/models/...:streamGenerateContent) and everything else on Chat
 * Completions. config.anthropicWire, geminiWire and responsesWire name which
 * models take which, checked in that order. Each model then reaches the
 * gateway on its vendor's own wire, so the gateway does not have to translate
 * tool results, images or thought signatures. The session sees one provider:
 * "cliproxy/claude-opus-5-5" and "cliproxy/gpt-6-astra" both resolve here.
 *
 * Account prefixes ("neu/claude-opus-5-5" is the same model from a second
 * account) keep their prefix on the wire; the catalog lookup ignores it, and
 * the display name says which account it is.
 *
 * A request with a Cyber access program (ChatRequest.accessPrograms, a
 * ChatGPT plan's GPT model) goes over the Responses wire, the one that
 * carries access_programs, whatever responsesWire says.
 */
import type { ProviderConfig } from '../config/schema';
import { AnthropicProvider } from './anthropic';
import type { ProviderOptions } from './common';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { OpenAIResponsesProvider } from './openai-responses';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types';
import { cyberChoices, cyberLabel, retiredAlias } from './access-programs';

/** "claude-*" style pattern to a test: * is any run of characters, the rest is literal. Case-insensitive. */
export function wirePattern(glob: string): RegExp {
  const re = glob
    .trim()
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 'i');
}

/** "neu/claude-opus-5-5" -> { account: "neu", model: "claude-opus-5-5" }. No slash: account "". */
export function splitAccount(id: string): { account: string; model: string } {
  const i = id.lastIndexOf('/');
  return i < 0 ? { account: '', model: id } : { account: id.slice(0, i), model: id.slice(i + 1) };
}

export class SplitWireProvider implements Provider {
  readonly type = 'openai' as const;
  readonly id: string;
  private readonly openai: Provider;
  private readonly anthropic?: AnthropicProvider;
  private readonly gemini?: GeminiProvider;
  /** The Responses wire, for responsesWire models and requests with an access program. */
  private responses?: Provider;
  private readonly patterns: RegExp[];
  private readonly geminiPatterns: RegExp[];
  private readonly responsesPatterns: RegExp[];

  constructor(private readonly opts: ProviderOptions) {
    this.id = opts.id;
    const cfg = opts.config;
    const plain: ProviderConfig = { ...cfg, anthropicWire: undefined, geminiWire: undefined, responsesWire: undefined };
    this.patterns = (cfg.anthropicWire?.models ?? []).map(wirePattern);
    this.geminiPatterns = (cfg.geminiWire?.models ?? []).map(wirePattern);
    this.responsesPatterns = (cfg.responsesWire?.models ?? []).map(wirePattern);
    this.openai = cfg.responsesApi ? new OpenAIResponsesProvider({ ...opts, config: plain }) : new OpenAIProvider({ ...opts, config: plain });
    if (cfg.anthropicWire) this.anthropic = new AnthropicProvider({ ...opts, config: { ...plain, type: 'anthropic', baseUrl: cfg.anthropicWire.baseUrl, responsesApi: undefined } });
    if (cfg.geminiWire) this.gemini = new GeminiProvider({ ...opts, config: { ...plain, type: 'gemini', baseUrl: cfg.geminiWire.baseUrl, responsesApi: undefined } });
  }

  /** True when this model goes over the Anthropic wire. */
  anthropicFor(model: string): boolean {
    return this.patterns.some((re) => re.test(model));
  }

  private geminiFor(model: string): boolean {
    return !this.anthropicFor(model) && this.geminiPatterns.some((re) => re.test(model));
  }

  private responsesWire(): Provider {
    if (this.openai instanceof OpenAIResponsesProvider) return this.openai;
    this.responses ??= new OpenAIResponsesProvider({ ...this.opts, config: { ...this.opts.config, anthropicWire: undefined, geminiWire: undefined, responsesWire: undefined, responsesApi: true } });
    return this.responses;
  }

  private pick(model: string, accessPrograms?: unknown): Provider {
    if (this.anthropicFor(model)) return this.anthropic!;
    if (this.geminiFor(model)) return this.gemini!;
    if (accessPrograms || this.responsesPatterns.some((re) => re.test(model))) return this.responsesWire();
    return this.openai;
  }

  stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const p = this.pick(req.model, req.accessPrograms);
    // only the Responses wire carries access_programs
    return p.stream(req.accessPrograms && !(p instanceof OpenAIResponsesProvider) ? { ...req, accessPrograms: undefined } : req);
  }

  model(id: string): ModelInfo {
    const info = this.pick(id).model(id);
    const { account, model } = splitAccount(id);
    // the plan's own name for it ("GPT-6.1-Sol"), before the account's short name goes on
    const meta = this.opts.config.modelMeta?.[model];
    if (meta?.name) info.name = meta.name;
    // a Daybreak alias is the picker's Daybreak row: named for its program, as the Codex app names it
    const alias = retiredAlias(model);
    if (alias) info.name = cyberLabel(alias.cyber);
    if (this.opts.config.subscription && !this.anthropicFor(id)) {
      const cyber = cyberChoices(model);
      if (cyber.length) info.cyber = cyber;
    }
    // a second account's copy of a model reads "Claude Opus 5.5, neu" in pickers
    if (account && info.name !== id) info.name = `${info.name}, ${account}`;
    // signed in plans (config.subscription): calls cost nothing per token, so pickers say "plan" and usage shows no API price
    if (this.opts.config.subscription && !this.opts.config.modelOverrides?.[id]) {
      info.inputPrice = 0;
      info.outputPrice = 0;
      info.cacheReadPrice = 0;
      info.cacheWritePrice = 0;
      info.cacheWrite1hPrice = 0;
    }
    return info;
  }

  async listModels(): Promise<ModelInfo[]> {
    const configured = this.opts.config.models;
    if (configured?.length) return configured.map((m) => this.model(m));
    const listed = await this.openai.listModels();
    return listed.map((m) => this.model(m.id));
  }

  countTokens(req: ChatRequest): Promise<number> {
    const p = this.pick(req.model, req.accessPrograms);
    if (!p.countTokens) return Promise.reject(new Error('token counting is not available for this model'));
    return p.countTokens(req);
  }

  embed(texts: string[], model?: string): Promise<number[][]> {
    if (!this.openai.embed) return Promise.reject(new Error('embeddings are not available on this provider'));
    return this.openai.embed(texts, model);
  }
}
