/**
 * Provider, model and harness marks from @lobehub/icons-static-svg (MIT).
 * Only the files below are bundled. Brand names and logos belong to their
 * owners; they identify the service and do not imply endorsement.
 *
 * TODO(settings builder): show LOGO_NOTICE as one meta line in Settings >
 * About (spec 8.5a).
 */
import claudecode from '@lobehub/icons-static-svg/icons/claudecode.svg?raw';
import claudecodeColor from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw';
import codex from '@lobehub/icons-static-svg/icons/codex.svg?raw';
import codexColor from '@lobehub/icons-static-svg/icons/codex-color.svg?raw';
import geminicli from '@lobehub/icons-static-svg/icons/geminicli.svg?raw';
import geminicliColor from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
import cline from '@lobehub/icons-static-svg/icons/cline.svg?raw';
import openhands from '@lobehub/icons-static-svg/icons/openhands.svg?raw';
import openhandsColor from '@lobehub/icons-static-svg/icons/openhands-color.svg?raw';
import claude from '@lobehub/icons-static-svg/icons/claude.svg?raw';
import claudeColor from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg?raw';
import geminiColor from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import deepseekColor from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg?raw';
import qwenColor from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?raw';
import kimiColor from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg?raw';
import mistralColor from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import meta from '@lobehub/icons-static-svg/icons/meta.svg?raw';
import metaColor from '@lobehub/icons-static-svg/icons/meta-color.svg?raw';
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg?raw';
import minimaxColor from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw';
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import google from '@lobehub/icons-static-svg/icons/google.svg?raw';
import googleColor from '@lobehub/icons-static-svg/icons/google-color.svg?raw';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg?raw';
import zhipuColor from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw';
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import openrouterColor from '@lobehub/icons-static-svg/icons/openrouter-color.svg?raw';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw';

/** One line for Settings > About (spec 8.5a). */
export const LOGO_NOTICE = 'Provider and model logos are trademarks of their owners and identify the service only. Icons by LobeHub, MIT license.';

export type LogoTier = 'harness' | 'model' | 'company';

export type LogoId =
  // harnesses
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'opencode'
  | 'cursor'
  | 'cline'
  | 'openhands'
  // model families
  | 'claude'
  | 'gpt'
  | 'gemini'
  | 'glm'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'mistral'
  | 'grok'
  | 'llama'
  | 'minimax'
  // companies, plans and accounts
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'zai'
  | 'zhipu'
  | 'moonshot'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'groq'
  | 'xai';

export interface LogoDef {
  id: LogoId;
  /** Display name, used for aria-label on standalone marks. */
  name: string;
  tier: LogoTier;
  /** currentColor version */
  mono: string;
  /** brand color version, when the maker publishes one */
  color?: string;
  /** brand colors that only read on one theme (e.g. a lime mark on white) */
  colorOn?: 'dark' | 'light';
}

/** Remove <title>, the 1em size and inline style; the wrapper sets size. */
function clean(svg: string): string {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/^<svg([^>]*)>/, (_m, attrs: string) => {
      const a = attrs
        .replace(/\s(width|height|style)="[^"]*"/g, '')
        .trim();
      return `<svg ${a} width="100%" height="100%" aria-hidden="true" focusable="false">`;
    });
}

function def(id: LogoId, name: string, tier: LogoTier, mono: string, color?: string, colorOn?: 'dark' | 'light'): LogoDef {
  return { id, name, tier, mono: clean(mono), color: color ? clean(color) : undefined, colorOn };
}

export const LOGOS: Record<LogoId, LogoDef> = {
  'claude-code': def('claude-code', 'Claude Code', 'harness', claudecode, claudecodeColor),
  codex: def('codex', 'Codex', 'harness', codex, codexColor),
  'gemini-cli': def('gemini-cli', 'Gemini CLI', 'harness', geminicli, geminicliColor),
  opencode: def('opencode', 'OpenCode', 'harness', opencode),
  cursor: def('cursor', 'Cursor', 'harness', cursor),
  cline: def('cline', 'Cline', 'harness', cline),
  openhands: def('openhands', 'OpenHands', 'harness', openhands, openhandsColor, 'light'),

  claude: def('claude', 'Claude', 'model', claude, claudeColor),
  gpt: def('gpt', 'GPT', 'model', openai),
  gemini: def('gemini', 'Gemini', 'model', gemini, geminiColor),
  glm: def('glm', 'GLM', 'model', zai),
  deepseek: def('deepseek', 'DeepSeek', 'model', deepseek, deepseekColor),
  qwen: def('qwen', 'Qwen', 'model', qwen, qwenColor),
  kimi: def('kimi', 'Kimi', 'model', kimi, kimiColor, 'dark'),
  mistral: def('mistral', 'Mistral', 'model', mistral, mistralColor),
  grok: def('grok', 'Grok', 'model', grok),
  llama: def('llama', 'Llama', 'model', meta, metaColor),
  minimax: def('minimax', 'MiniMax', 'model', minimax, minimaxColor),

  anthropic: def('anthropic', 'Anthropic', 'company', anthropic),
  openai: def('openai', 'OpenAI', 'company', openai),
  google: def('google', 'Google', 'company', google, googleColor),
  zai: def('zai', 'Z.ai', 'company', zai),
  zhipu: def('zhipu', 'Zhipu', 'company', zhipu, zhipuColor),
  moonshot: def('moonshot', 'Moonshot', 'company', moonshot),
  openrouter: def('openrouter', 'OpenRouter', 'company', openrouter, openrouterColor, 'dark'),
  ollama: def('ollama', 'Ollama', 'company', ollama),
  lmstudio: def('lmstudio', 'LM Studio', 'company', lmstudio),
  groq: def('groq', 'Groq', 'company', groq),
  xai: def('xai', 'xAI', 'company', xai),
};

export function isLogoId(id: string | undefined): id is LogoId {
  return !!id && id in LOGOS;
}
