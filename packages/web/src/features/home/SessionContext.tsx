/**
 * Read only context for an approval or question (spec 11.3): the session's
 * last assistant message and the tool calls after it, as log lines. Enough to
 * decide without opening the session.
 */
import { useEffect, useMemo } from 'react';
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { retainTranscript, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { LoadingRows } from '@/components/ui/EmptyState';
import { ModelName } from '@/components/logo';
import { NoteText } from './sections';

const MAX_TOOLS = 8;

function verb(name: string): string {
  if (name.startsWith('mcp__')) return 'MCP';
  const map: Record<string, string> = { Bash: 'Bash', Shell: 'Bash', Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write', Grep: 'Search', Glob: 'Search', WebFetch: 'Fetch', WebSearch: 'Search', Task: 'Agent', TodoWrite: 'Plan' };
  return map[name] ?? name;
}

function target(b: ToolUseBlock): string {
  const i = b.input;
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  return pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('description') ?? '';
}

function resultWords(r: ToolResultBlock | undefined, pending: boolean): { text: string; tone?: 'warn' | 'fault' } {
  if (pending) return { text: 'waiting on you', tone: 'warn' };
  if (!r) return { text: '' };
  if (r.isError) return { text: 'failed', tone: 'fault' };
  const body = typeof r.content === 'string' ? r.content : r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  const lines = body.split('\n').filter(Boolean).length;
  if (r.meta?.durationMs) return { text: `done in ${Math.max(1, Math.round(r.meta.durationMs / 1000))}s` };
  return { text: lines ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : 'done' };
}

function textOf(m: Message): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .trim();
}

export function SessionContext({ sessionId, pendingToolUseId, className }: { sessionId: string; pendingToolUseId?: string; className?: string }) {
  const messages = useHub((s) => s.messages[sessionId]);
  const loaded = useHub((s) => s.messagesLoaded[sessionId]);
  const session = useHub((s) => s.sessions[sessionId]);

  useEffect(() => retainTranscript(sessionId), [sessionId]);

  const view = useMemo(() => {
    if (!messages?.length) return undefined;
    let start = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && textOf(messages[i])) {
        start = i;
        break;
      }
    }
    const tail = start >= 0 ? messages.slice(start) : messages.slice(-6);
    const results: Record<string, ToolResultBlock> = {};
    for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') results[b.toolUseId] = b;
    const tools = tail.flatMap((m) => m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
    const said = start >= 0 ? messages[start] : undefined;
    return { said, tools: tools.slice(-MAX_TOOLS), hidden: Math.max(0, tools.length - MAX_TOOLS), results };
  }, [messages]);

  if (!loaded && !messages) return <LoadingRows loading rows={3} className={className} />;
  if (!view) return <p className={cn('text-[13px] text-fg-3', className)}>No messages in this session yet.</p>;

  return (
    <div className={className} aria-label="Session context">
      {view.said && (
        <>
          <p className="text-[12px] text-fg-3">
            {view.said.model || session?.model ? <ModelName model={view.said.model ?? session?.model} as="model" size={13} className="align-[-0.2em] text-fg-2" /> : <span className="text-fg-2">{session?.agent ?? 'Assistant'}</span>},{' '}
            <span className="num">{hhmm(view.said.createdAt)}</span>
          </p>
          <p className="mt-1.5 line-clamp-[10] text-[14.5px] leading-[1.6] whitespace-pre-wrap text-fg">
            <NoteText text={textOf(view.said)} />
          </p>
        </>
      )}
      {view.tools.length > 0 && (
        <div className="rows mt-3">
          {view.hidden > 0 && <p className="py-[7px] text-[12px] text-fg-3">{view.hidden} earlier tool calls</p>}
          {view.tools.map((b) => {
            const r = resultWords(view.results[b.id], b.id === pendingToolUseId && !view.results[b.id]);
            return (
              <div key={b.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-[7px]">
                <span className="text-[13px] font-medium text-fg-2">{verb(b.name)}</span>
                <span className="mono truncate text-fg">{target(b)}</span>
                <span className={cn('num text-right text-[12px]', r.tone === 'warn' ? 'text-warn' : r.tone === 'fault' ? 'text-fault' : 'text-fg-3')}>{r.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
