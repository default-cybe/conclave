/**
 * Extensions > MCP servers (docs/extensions/IA.md). Rows with status,
 * transport, tool count, origin and the last error with what to do.
 * Restart, Test, Tools (with Try), Connect to my CLIs, Edit, On or off,
 * Remove. Add a server by form or by pasting another CLI's config.
 * ?add=1 opens the add form; ?server=<name> marks that server.
 */
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import type { McpStatus, McpTestResult } from '@conclave/core/client';
import type { McpServerConfig } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { duration, plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button, IconButton } from '@/components/ui/Button';
import { ConfirmDialog, Menu, type MenuItem } from '@/components/ui/Overlay';
import { SelectedMark, StateWord } from '@/components/ui/List';
import { Notice, TextAction } from '@/components/ui/Section';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { LiveStatus } from '@/components/motion';
import { ConnectDrawer } from './mcp/ConnectDrawer';
import { ServerForm } from './mcp/ServerForm';
import { ToolsDrawer } from './mcp/ToolsDrawer';
import { scrollBehavior } from './hooks/model';
import { SourceBadge } from './shared/SourceBadge';
import { advice, target, transportOf } from './mcp/parts';
import { errText } from '@/features/settings/parts';

type TestState = { busy: true } | ({ busy: false } & McpTestResult) | { busy: false; ok: false; error: string; ms?: undefined; tools?: undefined };

export function StatusWord({ st }: { st: McpStatus }) {
  if (st.status === 'connecting') return <LiveStatus state="tool" label="Connecting" still />;
  if (st.status === 'failed') return <StateWord tone="fault">failed</StateWord>;
  if (st.status === 'disabled') return <StateWord tone="dim">off</StateWord>;
  return <StateWord tone="ok">connected</StateWord>;
}

export function McpServersTab() {
  const mobile = useIsMobile();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const focus = params.get('server');
  const config = useHub((s) => s.config);
  const servers = (config?.mcpServers ?? {}) as Record<string, McpServerConfig>;
  const load = useLoad(() => api().mcp(), []);
  const [list, setList] = useState<McpStatus[]>();
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<{ name: string | null; mode: 'form' | 'paste' } | null>(null);
  const [tools, setTools] = useState<string | null>(null);
  const [connect, setConnect] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const reload = useRef(load.reload);
  reload.current = load.reload;

  useEffect(() => setList(load.data), [load.data]);

  // ?add=1 opens the add form once
  useEffect(() => {
    if (params.get('add') === '1') {
      setForm({ name: null, mode: 'form' });
      navigate('/extensions/mcp', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (!focus || !list) return;
    const t = setTimeout(() => document.getElementById(`mcp-${focus}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() }), 80);
    return () => clearTimeout(t);
  }, [focus, list]);

  // a server that is still connecting is checked again shortly
  const connecting = list?.some((s) => s.status === 'connecting');
  useEffect(() => {
    if (!connecting) return;
    const t = setInterval(() => reload.current(), 1500);
    return () => clearInterval(t);
  }, [connecting]);

  // the hub reloads config on changes; follow it
  const configVersion = useHub((s) => s.configVersion);
  useEffect(() => {
    if (configVersion) reload.current();
  }, [configVersion]);

  const patch = (st: McpStatus) => setList((l) => l?.map((x) => (x.name === st.name ? st : x)));

  const restart = async (name: string) => {
    setRestarting((r) => ({ ...r, [name]: true }));
    const st = await attempt(() => api().restartMcp(name));
    setRestarting((r) => ({ ...r, [name]: false }));
    if (st) {
      patch(st);
      setTests((t) => {
        const n = { ...t };
        delete n[name];
        return n;
      });
      if (st.status === 'failed') toast({ title: `${name} still fails to start. ${advice(st.error, servers[name])}`, level: 'error' });
      else toast({ title: `${name} restarted, ${plural(st.tools, 'tool')}.` });
    }
  };

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: { busy: true } }));
    try {
      const r = await api().testMcp(name);
      setTests((t) => ({ ...t, [name]: { busy: false, ...r } }));
      reload.current();
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { busy: false, ok: false, error: errText(e) } }));
    }
  };

  const setEnabled = async (name: string, enabled: boolean) => {
    const st = await attempt(() => api().updateMcpServer(name, { enabled }));
    if (st) {
      patch(st);
      toast({ title: enabled ? `${name} is on. The hub starts it now.` : `${name} is off. Its tools leave new sessions.` });
    }
  };

  const total = list?.length ?? 0;
  const counts = {
    connected: list?.filter((s) => s.status === 'connected').length ?? 0,
    failed: list?.filter((s) => s.status === 'failed').length ?? 0,
    off: list?.filter((s) => s.status === 'disabled').length ?? 0,
  };
  const parts = [<>{plural(total, 'server')}</>, counts.connected ? <>{counts.connected} connected</> : null, counts.failed ? <span className="text-fault">{counts.failed} failed</span> : null, counts.off ? <>{counts.off} off</> : null].filter(Boolean);

  return (
    <div className="space-y-7 phone:space-y-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="m-0 min-w-0 flex-1 text-[14px] leading-[1.45] text-fg-2 phone:basis-full phone:text-[15px]">
          {list && total
            ? parts.map((p, i) => (
                <span key={i}>
                  {p}
                  {i < parts.length - 1 ? ', ' : '.'}
                </span>
              ))
            : ' '}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={() => setForm({ name: null, mode: 'paste' })}>
            Paste from another CLI
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => setForm({ name: null, mode: 'form' })}>
            Add a server
          </Button>
        </div>
      </div>

      <section aria-label="Servers">
        {load.error && !list && (
          <Notice tone="fault" action={{ label: 'Retry', onClick: load.reload }}>
            {`Failed. Could not load MCP servers: ${errText(load.error)} Check that the hub is running, then retry.`}
          </Notice>
        )}
        <LoadingRows loading={load.loading && !list} rows={4} />
        {list && list.length === 0 && (
          <EmptyState action={{ label: 'Add a server', onClick: () => setForm({ name: null, mode: 'form' }) }}>
            MCP servers give agents extra tools, like your notes in Basic Memory or the Proxmox API. Add one here, or paste the config you already use in Claude Code or Codex.
          </EmptyState>
        )}
        <div className={cn('rows', list && list.length > 0 && 'border-t border-rule-2')}>
          {list?.map((st) => {
            const cfg = servers[st.name];
            const own = st.origin !== 'plugin';
            const off = st.status === 'disabled';
            const t = tests[st.name];
            const items: MenuItem[] = [
              { label: 'Tools', disabled: st.status !== 'connected', detail: st.status === 'connected' ? undefined : 'Connect it first', onSelect: () => setTools(st.name) },
              { label: 'Test', disabled: off, onSelect: () => void test(st.name) },
              { label: 'Restart', disabled: off, onSelect: () => void restart(st.name) },
              { label: 'Connect to my CLIs', onSelect: () => setConnect(st.name) },
              { separator: true, label: '' },
            ];
            if (own)
              items.push(
                { label: 'Edit', disabled: !cfg, onSelect: () => setForm({ name: st.name, mode: 'form' }) },
                { label: off ? 'Turn on' : 'Turn off', onSelect: () => void setEnabled(st.name, off) },
                { separator: true, label: '' },
                { label: 'Remove', danger: true, onSelect: () => setRemoving(st.name) },
              );
            else items.push({ label: `From plugin ${st.plugin ?? ''}, read only`, detail: 'Turn the plugin off to stop it', disabled: true }, { label: 'Open the plugin', onSelect: () => navigate(`/extensions/plugins?plugin=${encodeURIComponent(st.plugin ?? '')}`) });
            const failed = st.status === 'failed';
            return (
              <div
                key={st.name}
                id={`mcp-${st.name}`}
                aria-current={focus === st.name ? 'true' : undefined}
                className={cn('relative scroll-mt-6 py-3.5', focus === st.name && '-mx-3 bg-raise px-3 phone:-mx-2 phone:px-2')}
              >
                {focus === st.name && <SelectedMark />}
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-3">
                      <span className={cn('t-row min-w-0 truncate font-mono text-[13px] phone:text-[14.5px]', off ? 'text-fg-3' : 'text-fg')}>{st.name}</span>
                      <span className="ml-auto shrink-0 text-[13px] phone:text-[14px]">
                        <StatusWord st={st} />
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
                      {transportOf(st, cfg)}
                      {st.status === 'connected' && <>, {plural(st.tools, 'tool')}</>}, from{' '}
                      {st.origin === 'plugin' && st.plugin ? (
                        <Link href={`/extensions/plugins?plugin=${encodeURIComponent(st.plugin)}`} className="tap hover:text-fg">
                          <SourceBadge source="plugin" plugin={st.plugin} className="text-inherit" />
                        </Link>
                      ) : st.origin === 'project' ? (
                        <span title="The project's .mcp.json">this project</span>
                      ) : (
                        <SourceBadge source="config" label="your config" />
                      )}
                    </div>
                    {cfg && <div className="mt-0.5 truncate font-mono text-[12px] text-fg-3" title={target(cfg)}>{target(cfg)}</div>}
                    {failed && (
                      <div className="mt-2 text-[13px] leading-[1.45] phone:text-[14px]">
                        <div className="text-fault">{st.error ?? 'Failed to start.'}</div>
                        <div className="mt-0.5 text-fg-2">{advice(st.error, cfg)}</div>
                      </div>
                    )}
                    {t && (
                      <div className="mt-2 text-[13px] leading-[1.45] phone:text-[14px]" aria-live="polite">
                        {t.busy ? (
                          <LiveStatus state="tool" label="Testing" />
                        ) : t.ok ? (
                          <span className="text-fg-2">
                            <span className="text-ok">Works.</span> {plural(t.tools ?? 0, 'tool')} in {duration(t.ms)}.
                          </span>
                        ) : (
                          <span className="text-fg-2">
                            <span className="text-fault">Test failed.</span> {failed && t.error === st.error ? 'Same error as above.' : t.error}
                            {!failed && <span className="block">{advice(t.error, cfg)}</span>}
                          </span>
                        )}
                      </div>
                    )}
                    {!mobile && (
                      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        {st.status === 'connected' && <TextAction label="Tools" onClick={() => setTools(st.name)} />}
                        {!off && <TextAction label={t?.busy ? 'Testing' : 'Test'} onClick={() => void test(st.name)} />}
                        {!off && <TextAction label={restarting[st.name] ? 'Restarting' : 'Restart'} onClick={() => void restart(st.name)} />}
                        <TextAction label="Connect to my CLIs" onClick={() => setConnect(st.name)} />
                        {own && off && <TextAction label="Turn on" onClick={() => void setEnabled(st.name, true)} />}
                      </div>
                    )}
                  </div>
                  <Menu
                    label={`${st.name} actions`}
                    width={260}
                    items={items}
                    trigger={({ ref, props }) => (
                      <IconButton ref={ref} label={`${st.name} actions`} size={mobile ? 'touch' : 'sm'} className={cn(mobile ? '-mt-2 -mr-2' : '-mt-1')} {...props}>
                        <MoreHorizontal />
                      </IconButton>
                    )}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {list && list.length > 0 && (
        <p className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          Tools reach agents as <span className="mono">mcp__server__tool</span>. An agent can limit itself to some servers in its editor. Servers in a project <span className="mono">.mcp.json</span> are listed in the trust note of Hooks and Tools; Conclave does not start them yet.
        </p>
      )}

      <ServerForm
        open={!!form}
        onClose={() => setForm(null)}
        name={form?.name ?? null}
        cfg={form?.name ? servers[form.name] : undefined}
        taken={list?.map((s) => s.name) ?? Object.keys(servers)}
        startMode={form?.mode}
        onSaved={() => load.reload()}
      />
      <ToolsDrawer server={tools} open={!!tools} onClose={() => setTools(null)} />
      <ConnectDrawer server={connect} open={!!connect} onClose={() => setConnect(null)} />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing ?? ''}?`}
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          const name = removing!;
          if (await attempt(() => api().removeMcpServer(name))) {
            setList((l) => l?.filter((x) => x.name !== name));
            toast({ title: `${name} removed.` });
          }
        }}
        body={
          <>
            It stops on the hub and its tools leave every session. Permission rules that name <span className="mono">mcp__{removing}__</span> stay until you remove them.
          </>
        }
      />
    </div>
  );
}
