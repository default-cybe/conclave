/**
 * One provider id over two wires. A gateway such as CLIProxyAPI serves Claude
 * models on the Anthropic Messages wire (/v1/messages) and everything else on
 * Chat Completions; config.anthropicWire names which models take which. The
 * session sees one provider: "cliproxy/claude-opus-5-5" and
 * "cliproxy/gpt-6-astra" both resolve here.
 *
 * Account prefixes ("neu/claude-opus-5-5" is the same model from a second
 * account) keep their prefix on the wire; the catalog lookup ignores it, and
 * the display name says which account it is.
 */
import type { ProviderConfig } from '../config/schema';
import { AnthropicProvider } from './anthropic';
import type { ProviderOptions } from './common';
import { OpenAIProvider } from './openai';
import { OpenAIResponsesProvider } from './openai-responses';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types';

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
  private readonly anthropic: AnthropicProvider;
  private readonly patterns: RegExp[];

  constructor(private readonly opts: ProviderOptions) {
    this.id = opts.id;
    const cfg = opts.config;
    const wire = cfg.anthropicWire!;
    this.patterns = wire.models.map(wirePattern);
    const openaiCfg: ProviderConfig = { ...cfg, anthropicWire: undefined };
    this.openai = cfg.responsesApi ? new OpenAIResponsesProvider({ ...opts, config: openaiCfg }) : new OpenAIProvider({ ...opts, config: openaiCfg });
    this.anthropic = new AnthropicProvider({ ...opts, config: { ...cfg, type: 'anthropic', baseUrl: wire.baseUrl, anthropicWire: undefined, responsesApi: undefined } });
  }

  /** True when this model goes over the Anthropic wire. */
  anthropicFor(model: string): boolean {
    return this.patterns.some((re) => re.test(model));
  }

  private pick(model: string): Provider {
    return this.anthropicFor(model) ? this.anthropic : this.openai;
  }

  stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    return this.pick(req.model).stream(req);
  }

  model(id: string): ModelInfo {
    const info = this.pick(id).model(id);
    const { account } = splitAccount(id);
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
    const p = this.pick(req.model);
    if (!p.countTokens) return Promise.reject(new Error('token counting is not available for this model'));
    return p.countTokens(req);
  }

  embed(texts: string[], model?: string): Promise<number[][]> {
    if (!this.openai.embed) return Promise.reject(new Error('embeddings are not available on this provider'));
    return this.openai.embed(texts, model);
  }
}
