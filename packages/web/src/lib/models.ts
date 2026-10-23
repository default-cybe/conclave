/**
 * Model, harness and provider identity: refs, display names, families.
 * Logos resolve from these in components/logo/resolve.ts.
 */

export type Family = 'anthropic' | 'openai' | 'google' | 'zai' | 'local' | 'openrouter' | 'other';

/** CLI coding agents Conclave can drive. Their refs look like "claude-code/opus". */
export const HARNESSES: Record<string, { family: Family; label: string }> = {
  'claude-code': { family: 'anthropic', label: 'Claude Code' },
  codex: { family: 'openai', label: 'Codex' },
  'gemini-cli': { family: 'google', label: 'Gemini CLI' },
  opencode: { family: 'other', label: 'OpenCode' },
  cursor: { family: 'other', label: 'Cursor' },
  cline: { family: 'other', label: 'Cline' },
  openhands: { family: 'other', label: 'OpenHands' },
};

/** How their makers write provider and plan names. */
export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  'claude-max': 'Claude Max',
  'claude-pro': 'Claude Pro',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  'chatgpt-pro': 'ChatGPT Pro',
  codex: 'Codex',
  google: 'Google',
  gemini: 'Gemini',
  'ai-studio': 'AI Studio',
  zai: 'Z.ai',
  'zai-coding': 'Z.ai Coding',
  zhipu: 'Zhipu',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  kimi: 'Kimi',
  mistral: 'Mistral',
  groq: 'Groq',
  xai: 'xAI',
  qwen: 'Qwen',
  dashscope: 'Alibaba Cloud',
  minimax: 'MiniMax',
  meta: 'Meta',
  cliproxy: 'CLIProxy',
  ...Object.fromEntries(Object.entries(HARNESSES).map(([k, v]) => [k, v.label])),
};

export function splitRef(ref: string | undefined): { provider: string; model: string } {
  if (!ref) return { provider: '', model: '' };
  const i = ref.indexOf('/');
  if (i < 0) return { provider: '', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/** "claude-code/opus" -> "claude-code". Also accepts a bare harness id. */
export function harnessId(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (HARNESSES[ref]) return ref;
  const p = splitRef(ref).provider;
  return HARNESSES[p] ? p : undefined;
}

export function isHarness(ref: string | undefined): boolean {
  return harnessId(ref) !== undefined;
}

/** "Claude Code" for any claude-code ref. */
export function harnessLabel(ref: string | undefined): string | undefined {
  const h = harnessId(ref);
  return h ? HARNESSES[h].label : undefined;
}

export function providerName(id: string | undefined): string {
  if (!id) return '';
  return PROVIDER_NAMES[id] ?? PROVIDER_NAMES[id.toLowerCase()] ?? titleCase(id);
}

// ---------------------------------------------------------------------------
// Display names: "Opus 5.5", "GPT-5.5 Codex", "Gemini 3 Pro", "GLM-5"
// ---------------------------------------------------------------------------

const WORDS: Record<string, string> = {
  pro: 'Pro',
  flash: 'Flash',
  lite: 'Lite',
  mini: 'mini',
  nano: 'nano',
  air: 'Air',
  coder: 'Coder',
  codex: 'Codex',
  chat: 'Chat',
  reasoner: 'Reasoner',
  instruct: 'Instruct',
  turbo: 'Turbo',
  large: 'Large',
  medium: 'Medium',
  small: 'Small',
  max: 'Max',
  plus: 'Plus',
  thinking: 'Thinking',
  preview: 'Preview',
  latest: 'latest',
  exp: 'Exp',
  vision: 'Vision',
};

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? (/^\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Format a raw model id the way its maker writes it in prose. */
export function formatModelId(id: string): string {
  let m = id.toLowerCase();
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  m = m.replace(/-\d{8}$/, '').replace(/@.*$/, '').replace(/-latest$/, '');
  let r: RegExpMatchArray | null;
  // claude-opus-5-5, claude-sonnet-4-5, opus, sonnet
  if ((r = m.match(/^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d+))?)?(.*)$/))) {
    const v = r[2] ? ` ${r[2]}${r[3] ? '.' + r[3] : ''}` : '';
    return `${r[1][0].toUpperCase()}${r[1].slice(1)}${v}${r[4] ? ' ' + titleCase(r[4]) : ''}`;
  }
  if ((r = m.match(/^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)(.*)$/))) {
    return `${r[3][0].toUpperCase()}${r[3].slice(1)} ${r[1]}${r[2] ? '.' + r[2] : ''}`;
  }
  if ((r = m.match(/^gpt-?([\d.]+o?)(?:-(.*))?$/))) return `GPT-${r[1]}${r[2] ? ' ' + titleCase(r[2]) : ''}`;
  if ((r = m.match(/^(o\d)(?:-(.*))?$/))) return `${r[1]}${r[2] ? '-' + r[2] : ''}`;
  if ((r = m.match(/^codex(?:-(.*))?$/))) return `Codex${r[1] ? ' ' + titleCase(r[1]) : ''}`;
  if ((r = m.match(/^gemini-([\d.]+)(?:-(.*))?$/))) return `Gemini ${r[1]}${r[2] ? ' ' + titleCase(r[2]) : ''}`;
  if ((r = m.match(/^glm-([\d.]+v?)(?:-(.*))?$/))) return `GLM-${r[1].toUpperCase()}${r[2] ? ' ' + titleCase(r[2]) : ''}`;
  if ((r = m.match(/^deepseek-(.*)$/))) return `DeepSeek ${titleCase(r[1])}`;
  if ((r = m.match(/^qwen([\d.]*)[-:]?(.*)$/))) return `Qwen${r[1]}${r[2] ? ' ' + titleCase(r[2].replace(/:/g, '-')) : ''}`;
  if ((r = m.match(/^kimi-(.*)$/))) return `Kimi ${titleCase(r[1])}`;
  if ((r = m.match(/^grok-(.*)$/))) return `Grok ${titleCase(r[1])}`;
  if ((r = m.match(/^llama-?([\d.]+)(?:-(.*))?$/))) return `Llama ${r[1]}${r[2] ? ' ' + titleCase(r[2]) : ''}`;
  if ((r = m.match(/^minimax-(.*)$/))) return `MiniMax ${titleCase(r[1])}`;
  if ((r = m.match(/^(mistral|codestral|devstral|magistral|ministral)(?:-(.*))?$/))) return `${titleCase(r[1])}${r[2] ? ' ' + titleCase(r[2]) : ''}`;
  return titleCase(m.replace(/:/g, '-'));
}

/** Names known to the hub (ModelInfo.name), filled by the store. */
const knownNames = new Map<string, string>();

export function registerModelNames(entries: Array<{ ref: string; name: string }>) {
  for (const e of entries) knownNames.set(e.ref, e.name.replace(/^Claude (?=(Opus|Sonnet|Haiku)\b)/, ''));
}

/**
 * Display name for a model ref.
 * - "anthropic/claude-sonnet-5-5" -> "Sonnet 5.5"
 * - "openrouter/deepseek/deepseek-v4" -> "DeepSeek V4"
 * - "claude-code/opus" -> "Opus"; "claude-code/default" -> "Claude Code"
 */
export function modelName(ref: string | undefined): string {
  if (!ref) return '';
  const h = harnessId(ref);
  if (h) {
    const m = splitRef(ref).model;
    if (!m || m === 'default' || m === h) return HARNESSES[h].label;
    return formatModelId(m);
  }
  return knownNames.get(ref) ?? formatModelId(splitRef(ref).model || ref);
}

/** 200000 -> "200K", 1000000 -> "1M" */
export function contextLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}
