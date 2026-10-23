/**
 * A node's details on the Map: its state, agent and model, device and
 * folder, what it runs now, its recent tools, usage and subagents, with
 * Open chat and Stop. A side panel on desktop, a bottom sheet on phones.
 */
import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';
import type { MapNode, MapSnapshot, MapTool } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { StateWord } from '@/components/ui/List';
import { Sheet } from '@/components/ui/Overlay';
import { Elapsed } from '@/components/motion';
import { api } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { compact, countdown, duration, durationShort, hhmm, shortPath, usd } from '@/lib/format';
import { modelName } from '@/lib/models';
import { toast } from '@/store/store';
import { cn } from '@/lib/text';
import { STATE_TONE, STATE_WORD, canStop, childrenOf, nodeHref, shortId, stuckWords } from './model';

const KIND_WORD: Record<MapNode['kind'], string> = {
  chat: 'Chat',
  session: 'Session',
  subagent: 'Subagent',
  workflow: 'Workflow run',
  agent: 'Workflow agent',
};

export function NodeDrawer({ node, snap, phone, replay, onSelect, onClose }: { node: MapNode | undefined; snap: MapSnapshot; phone: boolean; replay: boolean; onSelect: (id: string) => void; onClose: () => void }) {
  if (phone)
    return (
      // the lower part of the screen: the map stays in sight above it
      <Sheet open={!!node} onClose={onClose} label={node?.title ?? 'Details'} className="max-h-[66dvh]!" footer={node && <Actions node={node} replay={replay} phone />}>
        {node && <Detail node={node} snap={snap} replay={replay} onSelect={onSelect} onClose={onClose} phone />}
      </Sheet>
    );
  if (!node) return null;
  return (
    <aside aria-label={`${node.title}, details`} className="anim-right absolute inset-y-0 right-0 z-10 flex w-[360px] max-w-full flex-col border-l border-rule bg-bg">
      <Detail node={node} snap={snap} replay={replay} onSelect={onSelect} onClose={onClose} />
      <div className="shrink-0 border-t border-rule px-5 py-3">
        <Actions node={node} replay={replay} />
      </div>
    </aside>
  );
}

/** Open chat, and Stop while it works. */
function Actions({ node: n, replay, phone }: { node: MapNode; replay: boolean; phone?: boolean }) {
  const [, navigate] = useLocation();
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      if (n.kind === 'workflow' && n.runId) await api().stopWorkflow(n.runId);
      else await api().abort(n.id);
    } catch (err) {
      toast({ id: `map-stop-${n.id}`, title: `Could not stop ${n.title}.`, body: (err as Error).message, level: 'error' });
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="flex gap-2">
      <Button variant="solid" size={phone ? 'touch' : 'md'} className={cn(phone && 'flex-1')} onClick={() => navigate(nodeHref(n))}>
        {n.kind === 'workflow' ? 'Open run' : 'Open chat'}
      </Button>
      {canStop(n) && !replay && (
        <Button variant="danger-outline" size={phone ? 'touch' : 'md'} className={cn(phone && 'flex-1')} busy={stopping ? 'Stopping' : undefined} onClick={() => void stop()}>
          Stop
        </Button>
      )}
    </div>
  );
}

function Detail({ node: n, snap, replay, onSelect, onClose, phone }: { node: MapNode; snap: MapSnapshot; replay: boolean; onSelect: (id: string) => void; onClose: () => void; phone?: boolean }) {
  const now = useNow(1000);
  const at = replay ? snap.at : now;
  const parent = n.parentId ? snap.nodes.find((x) => x.id === n.parentId) : undefined;
  const kids = childrenOf(snap.nodes, n.id);
  const device = snap.devices.find((d) => d.id === n.device);
  const stuck = stuckWords(n, at);
  const busy = n.state === 'running' || n.state === 'waiting';
  const runFor = (n.endedAt ?? (busy ? at : n.lastActivityAt)) - n.startedAt;

  return (
    <>
      <div className={cn('flex shrink-0 items-start gap-2', phone ? 'px-4 pb-1' : 'px-5 pt-4 pb-1')}>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-fg-3 phone:text-[13px]">
            {KIND_WORD[n.kind]}
            {parent && (
              <>
                {' of '}
                <button type="button" className="text-fg-2 underline decoration-rule-2 underline-offset-2 hov:text-fg" onClick={() => onSelect(parent.id)}>
                  {parent.title}
                </button>
              </>
            )}
          </div>
          <h2 className="t-title m-0 mt-0.5 break-words text-fg">{n.title}</h2>
          <div className="mt-1 flex items-baseline gap-2 text-[13px] phone:text-[14px]">
            <StateWord tone={stuck ? 'warn' : STATE_TONE[n.state]}>{stuck ?? STATE_WORD[n.state]}</StateWord>
            <span className="text-fg-3">
              {busy ? (
                <>
                  for <Elapsed since={n.startedAt} until={replay ? snap.at : undefined} format="short" />
                </>
              ) : n.state === 'paused' && n.resumeAt ? (
                `resumes in ${countdown(n.resumeAt, at)}`
              ) : n.endedAt ? (
                `at ${hhmm(n.endedAt)}`
              ) : null}
            </span>
            <span className="ml-auto font-mono text-[11px] text-fg-4">{shortId(n.id)}</span>
          </div>
        </div>
        {!phone && (
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid size-8 shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto', phone ? 'px-4 pb-2' : 'px-5 pb-4')}>
        {n.error && n.state === 'failed' && <p className="m-0 mt-2 text-[13px] break-words text-fault phone:text-[14px]">{n.error}</p>}

        <Block title="Now">
          {n.tool ? (
            <div className="flex items-baseline gap-2 text-[13.5px] phone:text-[15px]">
              <span className={cn('font-medium', n.state === 'waiting' ? 'text-warn' : 'text-fg')}>{n.tool.name}</span>
              {n.tool.target && <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">{n.tool.target}</span>}
              <span className="ml-auto text-fg-3">{replay ? durationShort(snap.at - n.tool.startedAt) : <Elapsed since={n.tool.startedAt} format="short" />}</span>
            </div>
          ) : (
            <div className="text-[13.5px] text-fg-3 phone:text-[15px]">{n.state === 'running' ? (n.rate > 0 ? 'Writing' : 'Thinking') : 'Nothing running'}</div>
          )}
          {n.state === 'waiting' && <div className="mt-1 text-[13px] text-warn phone:text-[14px]">{n.waitingOn === 'question' ? 'It asked you a question.' : 'It waits for your approval.'}</div>}
        </Block>

        <Block title="About">
          <Row k="Agent">{n.agent ?? 'default'}</Row>
          {n.model && <Row k="Model">{modelName(n.model)}</Row>}
          <Row k="Device">{device?.name ?? n.device}</Row>
          {n.cwd && (
            <Row k="Folder">
              <span className="font-mono text-[12.5px]">{shortPath(n.cwd, 3)}</span>
            </Row>
          )}
          <Row k="Started">{hhmm(n.startedAt)}</Row>
          <Row k="Last activity">{at - n.lastActivityAt < 45_000 ? 'just now' : `${durationShort(at - n.lastActivityAt)} ago`}</Row>
        </Block>

        {n.tools.length > 0 && (
          <Block title="Recent tools">
            <ul className="m-0 list-none p-0">
              {n.tools.map((t, i) => (
                <ToolRow key={t.id ?? i} t={t} at={at} />
              ))}
            </ul>
          </Block>
        )}

        <Block title="Usage">
          <Row k="In">
            <span className="num">{compact(n.usage.inputTokens)}</span>
          </Row>
          <Row k="Out">
            <span className="num">{compact(n.usage.outputTokens)}</span>
          </Row>
          <Row k="Cache">
            <span className="num">{compact(n.usage.cacheReadTokens)}</span> read, <span className="num">{compact(n.usage.cacheWriteTokens)}</span> written
          </Row>
          <Row k="Cost">
            <span className="num">{usd(n.usage.costUsd, { precise: true })}</span>
          </Row>
          <Row k="Tokens a minute">
            <span className={cn('num', n.state === 'running' && n.tokensPerMin > 0 && 'text-signal')}>{compact(n.tokensPerMin)}</span>
          </Row>
          <Row k="Run time">
            <span className="num">{durationShort(Math.max(0, runFor))}</span>
          </Row>
        </Block>

        {kids.length > 0 && (
          <Block title={n.kind === 'workflow' ? 'Agents' : 'Subagents'}>
            <ul className="m-0 list-none p-0">
              {kids.map((k) => (
                <li key={k.id}>
                  <button type="button" onClick={() => onSelect(k.id)} className="-mx-2 flex w-[calc(100%+16px)] items-baseline gap-3 rounded-[var(--r-1)] px-2 py-1.5 text-left hov:bg-hover">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg phone:text-[15px]">{k.title}</span>
                    <StateWord tone={STATE_TONE[k.state]} className="text-[12.5px] phone:text-[13px]">
                      {STATE_WORD[k.state]}
                    </StateWord>
                  </button>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>

    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-rule pt-3 first:border-t-0">
      <h3 className="m-0 mb-1.5 text-[12px] font-medium text-fg-3 phone:text-[13px]">{title}</h3>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-3 py-[3px] text-[13.5px] phone:text-[15px]">
      <span className="text-[12.5px] text-fg-3 phone:text-[14px]">{k}</span>
      <span className="min-w-0 truncate text-fg">{children}</span>
    </div>
  );
}

function ToolRow({ t, at }: { t: MapTool; at: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-baseline gap-3 py-[3px] text-[13px] phone:text-[14.5px]">
      <span className="font-medium text-fg-2">{t.name}</span>
      <span className="min-w-0 truncate font-mono text-[12px] text-fg-3">{t.target ?? ''}</span>
      <span className={cn('num text-right text-[12.5px]', t.error ? 'text-fault' : 'text-fg-3')} title={`${hhmm(t.startedAt)}, ${durationShort(at - t.startedAt)} ago`}>
        {t.durationMs !== undefined ? duration(t.durationMs) : ''}
      </span>
    </li>
  );
}
