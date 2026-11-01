/**
 * /mcp in a session: Connectors. Each MCP server with its status and tool
 * count, and a switch for this session alone (the server keeps running for
 * the others). Add a server opens the Extensions form; All servers shows
 * the MCP servers tab in the sheet.
 */
import { useMemo, useState } from 'react';
import type { McpServerConfig } from '@conclave/core/config/schema';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, upsertSession, useHub } from '@/store/store';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Notice, TextAction } from '@/components/ui/Section';
import { McpServersTab, StatusWord } from '@/features/extensions/McpServers';
import { ServerForm } from '@/features/extensions/mcp/ServerForm';
import { ExtCwdProvider } from '@/features/extensions/project';
import { SheetRouter } from './SessionSheet';

/** Servers turned off for this session (core session/connectors.ts). */
export function sessionMcpOff(s: Pick<Session, 'meta'>): string[] {
  const v = s.meta?.mcpOff;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function ConnectorsSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const mobile = useIsMobile();
  const load = useLoad(() => api().mcp(), []);
  const config = useHub((s) => s.config);
  const agent = useHub((s) => s.agents.find((a) => a.name === session.agent));
  const servers = (config?.mcpServers ?? {}) as Record<string, McpServerConfig>;
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const off = sessionMcpOff(session);
  const list = load.data ?? [];

  const forAgent = (name: string) => !agent?.mcpServers || agent.mcpServers.includes(name);
  const onHere = list.filter((st) => st.status === 'connected' && !off.includes(st.name) && forAgent(st.name));
  const tools = onHere.reduce((n, st) => n + st.tools, 0);

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    const next = on ? off.filter((x) => x !== name) : [...off, name];
    const s = await attempt(() => api().updateSession(session.id, { mcpOff: next.length ? next : null }), on ? `${name} is on in this session.` : `${name} is off in this session. Its tools leave the next turn.`);
    if (s) upsertSession(s);
    setBusy(null);
  };

  const line = useMemo(() => {
    if (!list.length) return '';
    return `${onHere.length} of ${plural(list.length, 'server')} on in this session, ${plural(tools, 'tool')}.`;
  }, [list.length, onHere.length, tools]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.45] text-fg-2 phone:basis-full phone:text-[15px]">{line || ' '}</p>
        <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => setAdding(true)}>
          Add a server
        </Button>
      </div>

      {load.error && !load.data && <Notice tone="fault" action={{ label: 'Retry', onClick: load.reload }}>{`Could not load the servers: ${load.error}`}</Notice>}
      <LoadingRows loading={load.loading && !load.data} rows={3} />
      {load.data && list.length === 0 && <p className="m-0 text-[13px] leading-[1.45] text-fg-3 phone:text-[15px]">No MCP servers yet. Add one to give agents tools such as your notes, GitHub or a homelab API.</p>}

      {list.length > 0 && (
        <ul className="rows m-0 list-none border-t border-rule-2 p-0" aria-label="Servers">
          {list.map((st) => {
            const here = !off.includes(st.name);
            const agentOff = !forAgent(st.name);
            const usable = st.status !== 'disabled' && !agentOff;
            return (
              <li key={st.name} className="flex items-center gap-3 py-3 phone:min-h-14">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-3">
                    <span className={cn('min-w-0 truncate font-mono text-[13px] phone:text-[14.5px]', usable && here ? 'text-fg' : 'text-fg-3')}>{st.name}</span>
                    <span className="shrink-0 text-[12px] phone:text-[13px]">
                      <StatusWord st={st} />
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3 phone:text-[13px]">
                    {st.status === 'connected' ? plural(st.tools, 'tool') : st.status === 'disabled' ? 'Off on the hub' : st.status === 'failed' ? (st.error ?? 'Failed to start') : 'Connecting'}
                    {agentOff && `, not for the ${session.agent} agent`}
                    {st.origin === 'plugin' && st.plugin ? `, from ${st.plugin}` : ''}
                  </div>
                </div>
                <OnOff size={mobile ? 'touch' : 'sm'} label={`${st.name} in this session`} checked={here && usable} disabled={!usable || busy === st.name} onChange={(v) => void toggle(st.name, v)} />
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] phone:text-[14px]">
        <TextAction label={all ? 'Hide all servers' : 'All servers'} onClick={() => setAll((x) => !x)} />
        <span className="text-[12px] text-fg-3 phone:text-[13px]">Off here keeps the server running for other sessions.</span>
      </div>
      {all && (
        <div className="border-t border-rule pt-5">
          <ExtCwdProvider cwd={session.device === 'local' ? session.cwd : undefined}>
            <SheetRouter base="/extensions/mcp" onLeave={onClose}>
              <McpServersTab />
            </SheetRouter>
          </ExtCwdProvider>
        </div>
      )}

      <ServerForm open={adding} onClose={() => setAdding(false)} name={null} taken={list.map((s) => s.name).concat(Object.keys(servers))} onSaved={() => load.reload()} />
    </div>
  );
}
