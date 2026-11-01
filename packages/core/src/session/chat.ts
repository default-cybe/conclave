/**
 * Chat mode: plain conversations from the Chat page. A chat is a normal
 * session with kind "chat", the chat agent, the hub as its device, and three
 * switches the owner sets per chat (web search, memory, effort).
 * An agent session keeps two of them: its effort and the memory switch.
 */
import type { ChatSettings, Session } from '../types';
import { isEffortSetting } from '../providers/effort';
import { isCyberProgram } from '../providers/access-programs';

/** The built-in agent new chats use unless the request names another. */
export const CHAT_AGENT = 'chat';

/** A switch the owner never touched is on; thinking falls back to the agent. */
export const CHAT_DEFAULTS: ChatSettings = { webSearch: true, memory: true };

/** Tools that reach outside services: the web switch takes maps away too, so a chat with it off stays offline. */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage']);
const MEMORY_TOOLS = new Set(['MemorySearch', 'MemorySave', 'MemoryForget', 'SessionSearch', 'SessionRead']);

/** The switches in force for a session, or undefined when it is not a chat. */
export function chatSettings(s: Pick<Session, 'kind' | 'chat'>): ChatSettings | undefined {
  if (s.kind !== 'chat') return undefined;
  return { ...CHAT_DEFAULTS, ...(s.chat ?? {}) };
}

/** Merge a patch into the current switches. Throws a message the API can return as a 400. */
export function mergeChatSettings(base: ChatSettings | undefined, patch: unknown): ChatSettings {
  const next: ChatSettings = { ...CHAT_DEFAULTS, ...(base ?? {}) };
  if (patch === undefined || patch === null) return next;
  if (typeof patch !== 'object' || Array.isArray(patch)) throw new Error('chat must be an object with webSearch, memory or thinking');
  const p = patch as Record<string, unknown>;
  for (const key of ['webSearch', 'memory'] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== 'boolean') throw new Error(`chat.${key} must be true or false`);
    next[key] = p[key] as boolean;
  }
  if (p.thinking !== undefined) {
    if (p.thinking === null) delete next.thinking;
    else if (isEffortSetting(p.thinking)) next.thinking = p.thinking;
    else throw new Error('chat.thinking must be off, low, medium, high, xhigh, max or ultra');
  }
  // the Cyber access program for a ChatGPT plan model; null goes back to Default (send nothing)
  if (p.cyber !== undefined) {
    if (p.cyber === null) delete next.cyber;
    else if (isCyberProgram(p.cyber)) next.cyber = p.cyber;
    else throw new Error('chat.cyber must be standard, daybreak_blue or daybreak_red');
  }
  return next;
}

/** True when the chat's switches allow this tool. Sessions that are not chats allow everything. */
export function chatAllowsTool(settings: ChatSettings | undefined, name: string): boolean {
  if (!settings) return true;
  // the browser reaches the web too (a chat with the assistant, which has it)
  if (!settings.webSearch && (WEB_TOOLS.has(name) || name.startsWith('browser_'))) return false;
  if (!settings.memory && MEMORY_TOOLS.has(name)) return false;
  return true;
}

/**
 * False for a chat or an agent session with memory off: no profile, no
 * recall, no notes written after the turn, no memory tools. An agent session
 * reads chat.memory too (the memory switch works for every session).
 */
export function chatUsesMemory(s: Pick<Session, 'kind' | 'chat'>): boolean {
  return (chatSettings(s) ?? s.chat)?.memory !== false;
}

/**
 * True when the session's switches allow this tool: a chat's web and memory
 * switches, an agent session's memory switch. Everything else is allowed.
 */
export function sessionAllowsTool(s: Pick<Session, 'kind' | 'chat'>, name: string): boolean {
  const chat = chatSettings(s);
  if (chat) return chatAllowsTool(chat, name);
  return s.chat?.memory !== false || !MEMORY_TOOLS.has(name);
}
