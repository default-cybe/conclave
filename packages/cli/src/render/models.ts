/** Model and provider display helpers: short names and a stable color per vendor. */

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#D97757',
  'claude-code': '#D97757',
  openai: '#10A37F',
  codex: '#10A37F',
  google: '#4285F4',
  gemini: '#4285F4',
  'gemini-cli': '#4285F4',
  zai: '#8B5CF6',
  openrouter: '#6366F1',
  opencode: '#F59E0B',
  deepseek: '#4D6BFE',
  xai: '#A3A3A3',
  mistral: '#FA520F',
  ollama: '#9CA3AF',
  groq: '#F55036',
  moonshot: '#22D3EE',
  qwen: '#7C3AED',
  minimax: '#E11D48',
  cliproxy: '#14B8A6',
};

const MODEL_HINTS: Array<[RegExp, string]> = [
  [/claude|opus|sonnet|haiku/i, '#D97757'],
  [/gpt|\bo\d|codex|chatgpt/i, '#10A37F'],
  [/gemini|gemma/i, '#4285F4'],
  [/glm|zai/i, '#8B5CF6'],
  [/deepseek/i, '#4D6BFE'],
  [/grok/i, '#A3A3A3'],
  [/qwen/i, '#7C3AED'],
  [/kimi|moonshot/i, '#22D3EE'],
  [/mistral|codestral|devstral/i, '#FA520F'],
  [/llama/i, '#0EA5E9'],
];

const PALETTE = ['#E879F9', '#38BDF8', '#FBBF24', '#34D399', '#F472B6', '#A78BFA', '#FB923C', '#2DD4BF'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Color for a "provider/model" ref (or a bare model name). */
export function modelColor(ref: string | undefined): string {
  if (!ref) return '#9CA3AF';
  const i = ref.indexOf('/');
  const provider = i > 0 ? ref.slice(0, i) : '';
  const model = i > 0 ? ref.slice(i + 1) : ref;
  for (const [re, c] of MODEL_HINTS) if (re.test(model)) return c;
  if (provider && PROVIDER_COLORS[provider]) return PROVIDER_COLORS[provider];
  return PALETTE[hash(ref) % PALETTE.length];
}

/** "anthropic/claude-sonnet-5-5" -> "claude-sonnet-5-5"; ACP "claude-code/default" -> "claude-code". */
export function shortModel(ref: string | undefined): string {
  if (!ref) return '?';
  const i = ref.indexOf('/');
  if (i < 0) return ref;
  const provider = ref.slice(0, i);
  const model = ref.slice(i + 1);
  if (model === 'default') return provider;
  if (['claude-code', 'codex', 'gemini-cli', 'opencode'].includes(provider)) return `${provider}:${model}`;
  return model;
}

export function providerOf(ref: string | undefined): string {
  if (!ref) return '';
  const i = ref.indexOf('/');
  return i > 0 ? ref.slice(0, i) : '';
}
