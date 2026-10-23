/**
 * The providers Conclave knows how to sign in to, in the order onboarding
 * and Settings list them (spec 11.11 step 2). Ids match hub config providers
 * and the secret names used with setSecret('providers', id, key).
 */
import type { ModelGroup } from '@conclave/core/client';

export type SignIn = 'key' | 'none' | 'login';

export interface ProviderInfo {
  id: string;
  /** How the maker writes it ("Z.ai"). */
  name: string;
  /** One line under the name. */
  description: string;
  signIn: SignIn;
  /** What a key starts with, for the placeholder ("sk-or-"). */
  keyPrefix?: string;
  /** API host shown while testing. */
  host: string;
  /** Where the owner creates a key. */
  console?: string;
  /** Listed under "More providers" until used. */
  more?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models with an API key', signIn: 'key', keyPrefix: 'sk-ant-', host: 'api.anthropic.com', console: 'console.anthropic.com' },
  { id: 'openai', name: 'OpenAI', description: 'GPT and o-series models', signIn: 'key', keyPrefix: 'sk-proj-', host: 'api.openai.com', console: 'platform.openai.com' },
  { id: 'zai', name: 'Z.ai', description: 'GLM Coding plan', signIn: 'key', host: 'api.z.ai', console: 'z.ai/manage-apikey' },
  { id: 'google', name: 'Google Gemini', description: 'Gemini through AI Studio', signIn: 'key', keyPrefix: 'AIza', host: 'generativelanguage.googleapis.com', console: 'aistudio.google.com' },
  { id: 'openrouter', name: 'OpenRouter', description: 'One key for hundreds of models', signIn: 'key', keyPrefix: 'sk-or-', host: 'openrouter.ai', console: 'openrouter.ai/keys' },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek V3 and R1', signIn: 'key', keyPrefix: 'sk-', host: 'api.deepseek.com', console: 'platform.deepseek.com' },
  { id: 'moonshot', name: 'Moonshot', description: 'Kimi models', signIn: 'key', keyPrefix: 'sk-', host: 'api.moonshot.ai', console: 'platform.moonshot.ai' },
  { id: 'ollama', name: 'Ollama', description: 'Local models on your machines', signIn: 'none', host: 'localhost:11434' },
  { id: 'mistral', name: 'Mistral', description: 'Mistral and Codestral', signIn: 'key', host: 'api.mistral.ai', console: 'console.mistral.ai', more: true },
  { id: 'groq', name: 'Groq', description: 'Fast open models', signIn: 'key', keyPrefix: 'gsk_', host: 'api.groq.com', console: 'console.groq.com', more: true },
  { id: 'xai', name: 'xAI', description: 'Grok models', signIn: 'key', keyPrefix: 'xai-', host: 'api.x.ai', console: 'console.x.ai', more: true },
  { id: 'lmstudio', name: 'LM Studio', description: 'Local models through LM Studio', signIn: 'none', host: 'localhost:1234', more: true },
  { id: 'qwen', name: 'Qwen', description: 'Qwen through Alibaba Cloud', signIn: 'key', keyPrefix: 'sk-', host: 'dashscope-intl.aliyuncs.com', more: true },
];

/** CLI logins that can stand in for a key (spec 11.11 step 2, "Found on this computer"). */
export const HARNESS_LOGINS: Array<{ id: string; name: string; plan: string; cli: string; company: string }> = [
  { id: 'claude-code', name: 'Claude Code', plan: 'Claude Max', cli: 'claude', company: 'anthropic' },
  { id: 'codex', name: 'Codex', plan: 'ChatGPT Pro', cli: 'codex', company: 'openai' },
  { id: 'gemini-cli', name: 'Gemini CLI', plan: 'Google account', cli: 'gemini', company: 'google' },
  { id: 'opencode', name: 'OpenCode', plan: 'Z.ai GLM Coding plan', cli: 'opencode', company: 'zai' },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Placeholder for the key field: "Paste a key that starts with sk-or-". */
export function keyPlaceholder(p: ProviderInfo | undefined): string {
  if (!p || p.signIn === 'none') return 'No key needed';
  return p.keyPrefix ? `Paste a key that starts with ${p.keyPrefix}` : 'Paste a key';
}

/**
 * The hub's providers the owner can let a person use (People, docs/design/ACCOUNTS.md 6):
 * the ones that are on and that the hub has a key for, or need none (a local server,
 * CLIProxyAPI once subscriptions are set up). The hub refuses a grant for any other.
 * Agent harnesses run on a person's own device with their own login: no key to share.
 */
export function hubKeyProviders(groups: ReadonlyArray<Pick<ModelGroup, 'provider' | 'name' | 'type' | 'configured' | 'enabled'>>): Array<{ id: string; name: string }> {
  return groups
    .filter((g) => g.enabled && g.configured && g.type !== 'acp')
    .map((g) => ({ id: g.provider, name: g.name !== g.provider ? g.name : (providerInfo(g.provider)?.name ?? g.provider) }));
}
