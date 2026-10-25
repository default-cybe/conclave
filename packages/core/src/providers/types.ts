import type { ContentBlock, JsonSchema, StopReason, Usage, LimitWindow } from '../types';
import type { Effort, ModelEffort } from './effort';
import type { CyberProgram } from './access-programs';

/**
 * Model capabilities and prices. Prices are USD per million tokens.
 */
export interface ModelInfo {
  /** Provider-local id, e.g. "claude-sonnet-5-5" or "glm-5". */
  id: string;
  /** Full ref "provider/id". */
  ref: string;
  provider: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  /** Supports extended thinking / reasoning effort. */
  thinking: boolean;
  /** Supports explicit prompt caching (Anthropic cache_control) or automatic prefix caching. */
  caching: 'explicit' | 'automatic' | 'none';
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  /** A cache write at the default lifetime (Anthropic: 5 minutes, 1.25x input). */
  cacheWritePrice: number;
  /** A 1 hour cache write (Anthropic: 2x input). Unset: 2x input when a 1h write is reported. */
  cacheWrite1hPrice?: number;
  /** Rough tier for routing: fast, smart, deep. */
  tier?: 'fast' | 'smart' | 'deep';
  /**
   * The Effort levels this model offers on its provider, whether Off exists,
   * and its default (providers/effort.ts). Set on the hub's model list and on
   * resolved models; absent when the model has no effort control.
   */
  effort?: ModelEffort;
  /** Cyber access programs a ChatGPT plan model takes (providers/access-programs.ts); absent where there is no choice. */
  cyber?: CyberProgram[];
}

export interface SystemBlock {
  text: string;
  /** Put a cache breakpoint after this block. */
  cache?: boolean;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Put a cache breakpoint after this message's last block. */
  cache?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ChatRequest {
  /** Provider-local model id. */
  model: string;
  system: SystemBlock[];
  messages: ProviderMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'any' | { name: string };
  maxTokens?: number;
  temperature?: number;
  /**
   * Reasoning budget. effort maps to OpenAI reasoning_effort / Gemini thinkingBudget.
   * off: the owner turned thinking off; Claude models that think unless told
   * otherwise get their off switch, other wires leave thinking out.
   */
  thinking?: { budgetTokens?: number; effort?: Effort; off?: boolean };
  /** Ask for JSON output matching this schema (best effort across providers). */
  responseSchema?: JsonSchema;
  /** Stable key for provider-side prompt cache routing (OpenAI prompt_cache_key). */
  cacheKey?: string;
  signal?: AbortSignal;
  /** Opaque ids for provider metadata (Anthropic metadata.user_id). */
  userId?: string;
  /** The conversation, for gateways that keep one conversation on one account (sent as ProviderConfig.sessionHeader). */
  session?: string;
  /** Prompt cache lifetime hint. */
  cacheTtl?: '5m' | '1h';
  /** Stop generating at any of these strings (not sent by the Responses API). */
  stopSequences?: string[];
  /** Access programs for a ChatGPT plan model (providers/access-programs.ts), sent as access_programs on the Responses wire. */
  accessPrograms?: { cyber: CyberProgram };
}

export type StreamEvent =
  | { type: 'start'; id?: string; model?: string }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; text: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_use_delta'; index: number; partialJson: string }
  | { type: 'rate_limit'; windows: LimitWindow[] }
  | { type: 'done'; content: ContentBlock[]; stopReason: StopReason; usage: Usage; accessPrograms?: Record<string, string> };

export interface Provider {
  readonly id: string;
  readonly type: 'anthropic' | 'openai' | 'gemini';
  /** Stream a completion. Throws ProviderError on failure. The last event is always "done". */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** Models from config, the built-in catalog, or the provider's /models endpoint. */
  listModels(): Promise<ModelInfo[]>;
  /** Capabilities for a model id, falling back to sensible defaults. */
  model(id: string): ModelInfo;
  /** Optional: embeddings for memory search. */
  embed?(texts: string[], model?: string): Promise<number[][]>;
  /** Optional: exact token count. */
  countTokens?(req: ChatRequest): Promise<number>;
  /** Optional: whether this wire carries a model's PDFs (documentsForWire's pdf flag). Default true. */
  readsPdf?(model: string): boolean;
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'overloaded'
  | 'context_length'
  | 'bad_request'
  | 'network'
  | 'aborted'
  | 'server'
  | 'unknown';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  /** Wait this long before retrying (from retry-after or the error body). */
  retryAfterMs?: number;
  /** When a usage window resets (epoch ms), for long limits like 5h subscription windows. */
  resetAt?: number;
  provider?: string;
  body?: string;
  /** spend_cap: the provider's own spend limit (Anthropic enforced_spend_limit_reached). budget: the owner's budget in Conclave (or a member's monthly budget on the hub's key). access: a member may not use this provider. */
  code?: 'spend_cap' | 'budget' | 'access';

  constructor(
    kind: ProviderErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number; resetAt?: number; provider?: string; body?: string; code?: 'spend_cap' | 'budget' | 'access' } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    Object.assign(this, extra);
  }

  get retryable(): boolean {
    return this.kind === 'overloaded' || this.kind === 'network' || this.kind === 'server' || (this.kind === 'rate_limit' && (this.retryAfterMs ?? 0) <= 90_000);
  }
}

/** Parse "provider/model" into parts. The model part may itself contain slashes (openrouter/anthropic/claude...). */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i < 0) return { provider: '', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
