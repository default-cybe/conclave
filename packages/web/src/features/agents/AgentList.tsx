/**
 * Agents list (spec 11.6): agents are words. A table with each agent's
 * purpose, its default model (logo and name), tools, memory and where it
 * comes from. Built in agents say so after the name and open read only.
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useLocation } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { AgentDef } from '@conclave/core/extensions/types';
import { useHub } from '@/store/store';
import { useIsOwner } from '@/lib/people';
import { openNewChat } from '@/store/ui';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Page, PageHeader } from '@/components/ui/Page';
import { Button, IconButton } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Overlay';
import { FilterLinks } from '@/components/ui/Tags';
import { ListRow } from '@/components/ui/List';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModelName } from '@/components/logo';
import { ON_BASELINE } from '@/features/routines/form';
import { isOtherCli, isReadOnly, memoryWord, sourceWord, toolsWord, useAgentDelete, useCopyToUser } from './agentWords';

type Filter = 'all' | 'yours' | 'builtin' | 'other';

export function AgentList() {
  const agents = useHub((s) => s.agents);
  const booted = useHub((s) => s.booted);
  const [, navigate] = useLocation();
  const phone = useIsMobile();
  const [filter, setFilter] = useState<Filter>('all');

  const groups = useMemo(() => {
    const yours = agents.filter((a) => a.source === 'user' || a.source === 'project');
    const builtin = agents.filter((a) => a.source === 'builtin');
    const other = agents.filter((a) => a.source !== 'user' && a.source !== 'project' && a.source !== 'builtin');
    return { all: agents, yours, builtin, other };
  }, [agents]);
  const list = useMemo(
    () => [...groups[filter]].sort((a, b) => Number(b.primary !== false) - Number(a.primary !== false) || a.name.localeCompare(b.name)),
    [groups, filter],
  );
  const open = (a: AgentDef) => navigate(`/agents/${encodeURIComponent(a.name)}`);
  // a member uses the hub's agents; only the owner adds them
  const owner = useIsOwner();

  return (
    <Page>
      <PageHeader
        title="Agents"
        actions={
          owner && (
            <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={() => navigate('/agents/new')}>
              New agent
            </Button>
          )
        }
      />
      {booted && agents.length === 0 ? (
        <div className="max-w-[720px]">
          <EmptyState action={{ label: 'New agent', onClick: () => navigate('/agents/new') }}>Agents pick a model, tools, skills and a voice for a kind of work. Add one, or drop Claude Code agent files into ~/.claude/agents.</EmptyState>
        </div>
      ) : (
        <>
          <FilterLinks
            label="Source"
            value={filter}
            onChange={setFilter}
            className="mb-5"
            options={[
              { value: 'all', label: 'All', count: groups.all.length },
              { value: 'yours', label: 'Yours', count: groups.yours.length },
              { value: 'builtin', label: 'Built in', count: groups.builtin.length },
              ...(groups.other.length ? [{ value: 'other' as const, label: 'Plugins and other CLIs', count: groups.other.length }] : []),
            ]}
          />
          {phone ? (
            <div className="rows border-t border-rule-2">
              {list.map((a) => (
                <ListRow
                  key={a.name}
                  inset={false}
                  href={`/agents/${encodeURIComponent(a.name)}`}
                  title={
                    <>
                      {a.name}
                      {kindWords(a) && <span className="ml-2 font-normal text-fg-3">{kindWords(a)}</span>}
                    </>
                  }
                  meta={<span className="truncate">{a.description}</span>}
                  right={a.model ? <span className="shrink-0 pt-0.5 text-[13px] text-fg-2"><ModelName model={a.model} size={13} /></span> : undefined}
                  className="py-3"
                />
              ))}
            </div>
          ) : (
            <table className="tbl">
              <caption className="sr-only">Agents</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="max-xl:hidden">
                    Tools
                  </th>
                  <th scope="col" className="max-xl:hidden">
                    Memory
                  </th>
                  <th scope="col">Source</th>
                  <th scope="col" className="w-8">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr
                    key={a.name}
                    data-click=""
                    tabIndex={0}
                    onClick={() => open(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) open(a);
                    }}
                    className="focus-visible:-outline-offset-2 focus-visible:[&>td]:bg-hover"
                  >
                    <td className="whitespace-nowrap">
                      <span className="text-[13.5px] font-medium text-fg">{a.name}</span>
                      {kindWords(a) && <span className="ml-2 text-[12px] text-fg-3">{kindWords(a)}</span>}
                    </td>
                    <td className="w-full max-w-0">
                      <span className="block truncate text-fg-2">{a.description}</span>
                    </td>
                    <td className="whitespace-nowrap text-fg-2">{a.model ? <ModelName model={a.model} size={14} className={ON_BASELINE} /> : <span className="text-fg-3">default</span>}</td>
                    <td className={cn('whitespace-nowrap max-xl:hidden', a.tools ? 'text-fg-2' : 'text-fg-3')}>{toolsWord(a)}</td>
                    <td className="whitespace-nowrap text-fg-3 max-xl:hidden">{memoryWord(a.memory)}</td>
                    <td className="whitespace-nowrap text-fg-3">{sourceWord(a)}</td>
                    <td className="py-0 align-middle">
                      <RowMenu agent={a} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Page>
  );
}

/** "built in", "subagent" or "built in, subagent" after the name. */
function kindWords(a: AgentDef): string {
  return [a.source === 'builtin' && 'built in', a.primary === false && 'subagent'].filter(Boolean).join(', ');
}

function RowMenu({ agent }: { agent: AgentDef }) {
  const [, navigate] = useLocation();
  const del = useAgentDelete(agent);
  const copy = useCopyToUser(agent);
  const owner = useIsOwner();
  const items: MenuItem[] = [{ label: 'Start a session', onSelect: () => openNewChat({ agent: agent.name }) }];
  if (owner) items.push(isOtherCli(agent) ? { label: 'Copy to user', onSelect: () => void copy.run() } : { label: isReadOnly(agent) ? 'Duplicate to edit' : 'Duplicate', onSelect: () => navigate(`/agents/new?from=${encodeURIComponent(agent.name)}`) });
  if (owner && !isReadOnly(agent)) items.push({ separator: true, label: '' }, { label: 'Delete', danger: true, onSelect: del.ask });
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();
  return (
    <span onClick={stop} onKeyDown={stop} className="inline-flex">
      <Menu
        label={`${agent.name} actions`}
        items={items}
        trigger={({ ref, props }) => (
          <IconButton ref={ref} label={`${agent.name} actions`} size="sm" tooltip={false} {...props}>
            <MoreHorizontal />
          </IconButton>
        )}
      />
      {del.dialog}
    </span>
  );
}
