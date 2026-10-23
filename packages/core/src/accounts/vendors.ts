/**
 * Vendors: the model family an account serves. A CLIProxyAPI credential's
 * provider (claude, codex, antigravity) and a native provider's family both
 * map onto one, so "Account 1, Account 2, then the API key" is one order.
 */
import { findCatalogEntry } from '../providers/catalog';
import { bareModel } from './policy';

export const VENDOR_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  xai: 'Grok',
  moonshot: 'Kimi',
  meta: 'Muse',
  zai: 'GLM',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  minimax: 'MiniMax',
  devin: 'Devin',
};

/** CLIProxyAPI credential type -> vendor. */
const CREDENTIAL_VENDOR: Record<string, string> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  codex: 'openai',
  antigravity: 'gemini',
  'gemini-cli': 'gemini',
  gemini: 'gemini',
  vertex: 'gemini',
  xai: 'xai',
  kimi: 'moonshot',
  'kimi-ai': 'moonshot',
  meta: 'meta',
  devin: 'devin',
};

export function vendorName(vendor: string): string {
  return VENDOR_NAMES[vendor] ?? vendor[0]?.toUpperCase() + vendor.slice(1);
}

export function credentialVendor(provider: string): string {
  return CREDENTIAL_VENDOR[provider.toLowerCase()] ?? provider.toLowerCase();
}

/** The vendor of a model id, from the catalog, else from its name. */
export function vendorOfModel(model: string): string | undefined {
  const id = bareModel(model).toLowerCase();
  const entry = findCatalogEntry(id);
  if (entry) return entry.family;
  if (id.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o\d|codex)/.test(id)) return 'openai';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('grok')) return 'xai';
  if (id.startsWith('kimi')) return 'moonshot';
  if (id.startsWith('muse')) return 'meta';
  return undefined;
}
