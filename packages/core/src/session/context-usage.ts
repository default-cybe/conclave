/**
 * What fills a session's context now (/context, like Claude Code's): the
 * system prompt, the tool list, the messages and the tool output among
 * them, against the model's window and the point where auto compaction
 * starts. Parts are counted like a request (chars / 4, compaction.ts);
 * the last reply's reported usage is given next to them when there is one.
 */
import type { Engine } from '../engine/engine';
import type { ContextUsageDto } from '../client';
import type { Message } from '../types';
import { activeMessages } from './transcript';
import { regionTokens } from './compaction';

const tok = (chars: number) => Math.ceil(chars / 4);

/** Tokens of the messages, with tool results counted apart. */
export function splitMessages(msgs: Message[]): { messages: number; toolOutput: number } {
  let text = 0;
  let output = 0;
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_result') output += typeof b.content === 'string' ? b.content.length : 2000;
      else if (b.type === 'text') text += b.text.length;
      else if (b.type === 'thinking') text += b.thinking.length;
      else if (b.type === 'tool_use') text += JSON.stringify(b.input).length + b.name.length;
      else text += 1500;
    }
  }
  return { messages: tok(text), toolOutput: tok(output) };
}

export async function contextUsage(engine: Engine, sessionId: string): Promise<ContextUsageDto> {
  const session = engine.requireSession(sessionId);
  const agent = engine.agentFor(session);
  const cfg = engine.config.get();
  let window = 200_000;
  try {
    window = engine.providers.resolve(session.model).info.contextWindow || window;
  } catch {
    /* an unknown model keeps the default */
  }
  const tools = engine.toolsFor(session, agent, session.mode, 0);
  const toolChars = tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length, 0);
  let system = 0;
  let systemKnown = true;
  try {
    const blocks = await engine.systemPromptFor(session, agent, session.model, session.mode, tools.map((t) => t.name));
    system = tok(blocks.reduce((n, b) => n + b.text.length, 0));
  } catch {
    // the device is offline: its instruction files cannot be read now
    systemKnown = false;
  }
  const all = engine.repos.messages.list(sessionId);
  const active = activeMessages(all);
  const { messages, toolOutput } = splitMessages(active);
  const last = [...all].reverse().find((m) => m.role === 'assistant' && m.usage);
  const measured = last?.usage ? last.usage.inputTokens + (last.usage.cacheReadTokens ?? 0) + (last.usage.cacheWriteTokens ?? 0) + last.usage.outputTokens : undefined;
  const compactAt = cfg.context.compactAt;
  return {
    model: session.model,
    window,
    compactAt,
    compactTokens: Math.round(window * compactAt),
    parts: { system, tools: tok(toolChars), messages, toolOutput },
    systemKnown,
    total: system + tok(toolChars) + messages + toolOutput,
    ...(measured ? { measured } : {}),
    toolCount: tools.length,
    mcpTools: tools.filter((t) => t.name.startsWith('mcp__')).length,
    deferredTools: engine.deferredToolsFor(sessionId).length,
    messageCount: active.length,
    summarized: active.length < all.filter((m) => m.kind !== 'notice').length,
    olderTokens: regionTokens(all.filter((m) => m.kind !== 'notice' && !active.includes(m))),
  };
}
