/**
 * /context in a session, as in Claude Code: what fills the context now. One
 * bar on the model's window, split into the system prompt, tools, messages
 * and tool output, with a tick where auto compaction starts; the same
 * numbers as rows under it. From GET /api/sessions/:id/context; an older hub
 * gets the last reply's usage only.
 */
import type { ContextUsageDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { compact, plural } from '@/lib/format';
import { modelName } from '@/lib/models';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Notice, TextAction } from '@/components/ui/Section';

type Part = { key: keyof ContextUsageDto['parts'] | 'free'; label: string; help: string; color: string };

/** Neutral ink, darkest first (spec: no accent for data). */
export const CONTEXT_PARTS: Part[] = [
  { key: 'system', label: 'System prompt', help: 'The agent, project instructions, memory and the skills list', color: 'var(--fg)' },
  { key: 'tools', label: 'Tools', help: 'Names, descriptions and inputs of the tools it can call', color: 'var(--fg-2)' },
  { key: 'messages', label: 'Messages', help: 'What you and the agent wrote since the last summary', color: 'var(--fg-3)' },
  { key: 'toolOutput', label: 'Tool output', help: 'What the tools returned: files read, command output', color: 'var(--fg-4)' },
];

/** Each part's share of the window, in percent, for the bar. */
export function contextShares(u: Pick<ContextUsageDto, 'parts' | 'window'>): Record<string, number> {
  const w = u.window || 1;
  return Object.fromEntries(Object.entries(u.parts).map(([k, v]) => [k, Math.min(100, (v / w) * 100)]));
}

export function ContextSheet({ session, openConnectors }: { session: Session; openConnectors: () => void }) {
  const mobile = useIsMobile();
  const count = useHub((s) => s.messages[session.id]?.length ?? 0);
  const load = useLoad(() => api().contextUsage(session.id), [session.id, count]);
  const u = load.data;

  if (load.error && !u) return <OlderHub session={session} error={load.error} />;
  if (!u) return <LoadingRows loading rows={4} />;
  const shares = contextShares(u);
  const pct = Math.round((u.total / (u.window || 1)) * 100);
  const atPct = Math.round(u.compactAt * 100);
  const left = Math.max(0, u.compactTokens - u.total);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="t-stat text-fg">{compact(u.total)}</span>
          <span className="text-[13px] text-fg-2 phone:text-[15px]">
            of {compact(u.window)} tokens, {pct}% of the {modelName(u.model)} window
          </span>
        </div>
        <div role="img" aria-label={`Context ${pct}% full. Auto compaction at ${atPct}%.`} className="relative mt-3 h-3 w-full overflow-visible rounded-[2px] bg-meter-off">
          <div className="flex h-full w-full overflow-hidden rounded-[2px]">
            {CONTEXT_PARTS.map((p) => (
              <div key={p.key} style={{ width: `${shares[p.key] ?? 0}%`, background: p.color }} className="h-full shrink-0" />
            ))}
          </div>
          {/* where auto compaction starts */}
          <div aria-hidden className="absolute -top-1 -bottom-1 w-px bg-warn" style={{ left: `${atPct}%` }} />
        </div>
        <p className="m-0 mt-2 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          Auto compaction at {atPct}% ({compact(u.compactTokens)}). {left > 0 ? `${compact(left)} to go.` : 'The next turn compacts first.'}
          {u.measured ? ` The last reply counted ${compact(u.measured)}.` : ''}
        </p>
      </div>

      <dl className="m-0 border-t border-rule-2">
        {CONTEXT_PARTS.map((p) => {
          const v = u.parts[p.key as keyof ContextUsageDto['parts']];
          // the share of what is in context now, so the split reads at any fill
          const ofUsed = u.total ? Math.round((v / u.total) * 100) : 0;
          return (
            <div key={p.key} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-rule py-2.5">
              <span aria-hidden className="size-2.5 translate-y-[1px] rounded-[2px]" style={{ background: p.color }} />
              <dt className="min-w-0">
                <span className="block text-[13px] text-fg phone:text-[15px]">{p.label}</span>
                <span className="block truncate text-[12px] text-fg-3 phone:text-[13px] phone:whitespace-normal">{p.key === 'system' && !u.systemKnown ? 'Not read: the device is offline' : p.help}</span>
              </dt>
              <dd className="num m-0 text-right text-[13px] text-fg-2 phone:text-[15px]">
                {compact(v)}
                <span className="block text-[12px] text-fg-3 phone:text-[13px]">{v > 0 && ofUsed < 1 ? '<1' : ofUsed}% of used</span>
              </dd>
              <div aria-hidden className="col-start-2 col-end-4 mt-1.5 h-[3px] overflow-hidden rounded-[1.5px] bg-meter-off">
                <div className="h-full" style={{ width: `${Math.min(100, (v / (u.total || 1)) * 100)}%`, background: p.color }} />
              </div>
            </div>
          );
        })}
        <div className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5">
          <span aria-hidden className="size-2.5 translate-y-[1px] rounded-[2px] bg-meter-off" />
          <dt className="text-[13px] text-fg-2 phone:text-[15px]">Free</dt>
          <dd className="num m-0 text-right text-[13px] text-fg-2 phone:text-[15px]">{compact(Math.max(0, u.window - u.total))}</dd>
        </div>
      </dl>

      <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
        {plural(u.toolCount, 'tool')} in each request{u.mcpTools ? `, ${u.mcpTools} of them from MCP servers` : ''}
        {u.deferredTools ? `; ${u.deferredTools} more MCP tools wait behind ToolSearch` : ''}. {plural(u.messageCount, 'message')} in context
        {u.summarized ? `; a summary holds ${compact(u.olderTokens)} of older ones` : ''}. Counted as characters over four.
      </p>
      <div className={cn('flex flex-wrap items-center gap-2', mobile && 'gap-3')}>
        <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={() => void attempt(() => api().compact(session.id), 'Compacting older messages.').then(() => load.reload())}>
          Compact now
        </Button>
        <TextAction label="Connectors" onClick={openConnectors} />
      </div>
    </div>
  );
}

/** A hub from before /context: the last reply's usage against the window. */
function OlderHub({ session, error }: { session: Session; error: string }) {
  const messages = useHub((s) => s.messages[session.id]);
  const models = useHub((s) => s.models);
  const info = models.flatMap((g) => g.models).find((m) => m.ref === session.model);
  const last = [...(messages ?? [])].reverse().find((m) => m.usage)?.usage;
  const used = last ? last.inputTokens + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0) : 0;
  return (
    <div className="space-y-3">
      <Notice tone="warn">{`This hub cannot break the context down yet (${error}). Update the hub for the full view.`}</Notice>
      {info && <p className="m-0 text-[13px] text-fg-2">{`The last reply used ${compact(used)} of ${compact(info.contextWindow)} tokens.`}</p>}
    </div>
  );
}
