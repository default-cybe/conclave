/**
 * One installed plugin: manifest fields, everything it adds (each linking to
 * its tab), hooks by event, MCP servers with their live status, the folder,
 * Update, Remove, and the install commands for Claude Code and Codex.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { McpStatus, PluginDetailDto } from '@conclave/core/client';
import type { HookEvent, HookMatcher } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { attempt, toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { longDate, plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { KV } from '@/components/ui/Section';
import { StateWord } from '@/components/ui/List';
import { Command } from '@/components/ui/Code';
import { HarnessName } from '@/components/logo';
import { Drawer } from '../hooks/Drawer';
import { EVENT_ORDER, anyWords, withPluginRoot } from '../hooks/model';
import { KNOWN_MARKETPLACES, addsWords, dataFolder, hookCount, marketplaceOf, runsCode, sourceWords } from './parts';
import { errText } from '@/features/settings/parts';

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="flex items-baseline gap-2 border-b border-rule-2 pb-[9px]">
        <h3 className="t-section text-fg">{title}</h3>
        {count !== undefined && <span className="num text-[13px] text-fg-3">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function ItemRow({ href, name, desc }: { href: string; name: string; desc?: string }) {
  return (
    <div>
      <Link href={href} className="-mx-2 block rounded-[var(--r-1)] px-2 py-2 hover:bg-hover">
        <span className="block truncate font-mono text-[12.5px] text-fg">{name}</span>
        {desc && <span className="mt-0.5 block text-[13px] leading-[1.4] text-fg-2 phone:text-[14px]">{desc}</span>}
      </Link>
    </div>
  );
}

function statusWord(s: McpStatus | undefined, pluginOn: boolean) {
  if (!pluginOn) return <StateWord tone="dim">off with the plugin</StateWord>;
  if (!s) return <StateWord tone="dim">not started</StateWord>;
  if (s.status === 'connected') return <StateWord tone="ok">connected</StateWord>;
  if (s.status === 'failed') return <StateWord tone="fault">failed</StateWord>;
  if (s.status === 'connecting') return <StateWord tone="signal">connecting</StateWord>;
  return <StateWord tone="dim">off</StateWord>;
}

export function PluginSheet({
  name,
  open,
  onClose,
  justInstalled,
  onChanged,
}: {
  name: string | null;
  open: boolean;
  onClose: () => void;
  /** Show the "this runs code" notice right after an install. */
  justInstalled?: boolean;
  onChanged: () => void;
}) {
  const mobile = useIsMobile();
  const [d, setD] = useState<PluginDetailDto | null>(null);
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string>();
  const [removing, setRemoving] = useState(false);

  const load = async (n: string) => {
    try {
      const [detail, status] = await Promise.all([api().pluginDetail(n), api().mcp().catch(() => [] as McpStatus[])]);
      setD(detail);
      setMcp(status);
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    if (!open || !name) return;
    setD(null);
    setError(undefined);
    setUpdateError(undefined);
    void load(name);
  }, [open, name]);

  const setEnabled = async (on: boolean) => {
    if (!d) return;
    setD({ ...d, enabled: on });
    if (await attempt(() => api().setPluginEnabled(d.name, on))) {
      onChanged();
      void load(d.name);
    } else setD({ ...d, enabled: !on });
  };

  const setHooks = async (on: boolean) => {
    if (!d) return;
    setD({ ...d, hooksEnabled: on });
    if (await attempt(() => api().setPluginHooks(d.name, on))) {
      onChanged();
      void load(d.name);
    } else setD({ ...d, hooksEnabled: !on });
  };

  const update = async () => {
    if (!d) return;
    setUpdating(true);
    setUpdateError(undefined);
    try {
      const next = await api().updatePlugin(d.name);
      const was = d.manifest.version;
      const now = next.manifest.version;
      toast({ title: now && was && now !== was ? `Updated ${d.name} from ${was} to ${now}.` : `${d.name} is up to date${now ? ` at ${now}` : ''}.`, level: 'success' });
      onChanged();
      void load(d.name);
    } catch (e) {
      setUpdateError(`${errText(e)} Check that the hub can reach the source, then try again.`);
      toast({ title: `Could not update ${d.name}.`, level: 'error' });
    } finally {
      setUpdating(false);
    }
  };

  const mk = d ? marketplaceOf(d.source) : undefined;
  const hooks = d ? EVENT_ORDER.filter((e) => d.hooks[e]?.length) : [];
  const servers = d ? Object.entries(d.mcpServers ?? {}) : [];
  const adds = d ? addsWords(d) : [];
  const author = d?.manifest.author ? (typeof d.manifest.author === 'string' ? d.manifest.author : d.manifest.author.name) : undefined;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        label={name ?? 'Plugin'}
        title={name ?? ''}
        sub={d ? [d.manifest.version ? `version ${d.manifest.version}` : 'no version', sourceWords(d), d.enabled ? 'enabled' : 'disabled'].join(', ') : ' '}
        footer={
          d && (
            <>
              <Button variant="danger" size={mobile ? 'touch' : 'md'} className="mr-auto" onClick={() => setRemoving(true)}>
                Remove
              </Button>
              <Button variant="outline" size={mobile ? 'touch' : 'md'} busy={updating ? 'Updating' : false} onClick={() => void update()}>
                Update
              </Button>
            </>
          )
        }
      >
        {error && (
          <p className="m-0 text-[14px] leading-[1.45] text-fg-2">
            {/^unknown plugin/.test(error) ? (
              <>No plugin called {name} is installed. It may have been removed. Find it in the Marketplace to install it again.</>
            ) : (
              <>
                <span className="text-fault">Failed.</span> {error} Check that the hub is running, then open the plugin again.
              </>
            )}
          </p>
        )}
        {!d && !error && <p className="m-0 text-[13px] text-fg-3">Loading the plugin.</p>}
        {d && (
          <>
            {justInstalled && runsCode(d) && (
              <p className="mt-0 mb-5 border-y border-rule-2 py-3 text-[14px] leading-[1.45] text-warn phone:text-[15px]">
                {d.name} added {[hookCount(d) ? plural(hookCount(d), 'hook') : '', servers.length ? plural(servers.length, 'MCP server') : ''].filter(Boolean).join(' and ')}. They run code on the hub from the next session. Turn the plugin off if you did not expect that.
              </p>
            )}
            {updateError && (
              <p role="alert" className="mt-0 mb-4 border-y border-rule-2 py-3 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
                <span className="text-fault">Update failed.</span> {updateError}
              </p>
            )}
            {d.manifest.description && <p className="m-0 max-w-[64ch] text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{d.manifest.description}</p>}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-rule py-3">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">Enabled</div>
                <div className="text-[12px] text-fg-3 phone:text-[13px]">{d.enabled ? 'Its parts load in new sessions.' : 'Nothing loads. It stays installed.'}</div>
              </div>
              <OnOff checked={d.enabled} onChange={(v) => void setEnabled(v)} label={`${d.name} enabled`} size={mobile ? 'touch' : 'sm'} />
            </div>
            {hookCount(d) > 0 && (
              <div className="flex items-center justify-between gap-3 border-b border-rule py-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">Hooks</div>
                  <div className="text-[12px] text-fg-3 phone:text-[13px]">
                    {d.hooksEnabled !== false ? `${plural(hookCount(d), 'hook')} run on the hub in new sessions.` : 'Off. Skills, commands and agents still load.'}
                  </div>
                </div>
                <OnOff checked={d.hooksEnabled !== false} disabled={!d.enabled} onChange={(v) => void setHooks(v)} label={`${d.name} hooks`} size={mobile ? 'touch' : 'sm'} />
              </div>
            )}

            <dl className="m-0 mt-4">
              {author && <KV k="Author">{author}</KV>}
              {d.manifest.homepage && (
                <KV k="Homepage">
                  <a href={d.manifest.homepage} target="_blank" rel="noreferrer" className="link [overflow-wrap:anywhere]">
                    {d.manifest.homepage}
                  </a>
                </KV>
              )}
              {d.manifest.repository && (
                <KV k="Repository" mono>
                  {d.manifest.repository}
                </KV>
              )}
              {d.manifest.license && <KV k="License">{d.manifest.license}</KV>}
              {d.manifest.keywords?.length ? <KV k="Keywords">{d.manifest.keywords.join(', ')}</KV> : null}
              <KV k="Source" mono>
                {d.source}
              </KV>
              <KV k="Installed">{longDate(d.installedAt)}</KV>
              <KV k="Folder" mono>
                {d.dir}
              </KV>
            </dl>

            <Block title="What it adds" count={undefined}>
              <p className="mt-2.5 mb-0 text-[13px] text-fg-2 phone:text-[14px]">
                {adds.length ? `${adds.join(', ')}.` : 'Nothing Conclave can load yet.'} {!d.enabled && adds.length ? 'None of it loads while the plugin is off.' : ''}
              </p>
            </Block>

            {d.agents.length > 0 && (
              <Block title="Agents" count={d.agents.length}>
                <div className="rows">
                  {d.agents.map((a) => (
                    <ItemRow key={a.name} href={`/agents/${encodeURIComponent(a.name)}`} name={a.name} desc={a.description} />
                  ))}
                </div>
              </Block>
            )}
            {d.commands.length > 0 && (
              <Block title="Commands" count={d.commands.length}>
                <div className="rows">
                  {d.commands.map((c) => (
                    <ItemRow key={c.name} href={`/extensions/commands?name=${encodeURIComponent(c.name)}`} name={`/${c.name}`} desc={c.description} />
                  ))}
                </div>
              </Block>
            )}
            {d.skills.length > 0 && (
              <Block title="Skills" count={d.skills.length}>
                <div className="rows">
                  {d.skills.map((s) => (
                    <ItemRow key={s.name} href={`/extensions/skills?name=${encodeURIComponent(s.name)}`} name={s.name} desc={s.description} />
                  ))}
                </div>
              </Block>
            )}
            {hooks.length > 0 && (
              <Block title="Hooks" count={hookCount(d)}>
                <div className="rows">
                  {hooks.map((ev: HookEvent) =>
                    (d.hooks[ev] as HookMatcher[]).map((g, gi) =>
                      g.hooks.map((h, hi) => {
                        const root = (h as { pluginRoot?: string }).pluginRoot ?? d.dir;
                        return (
                          <div key={`${ev}:${gi}:${hi}`}>
                          <Link href={`/extensions/hooks?event=${ev}`} className="-mx-2 block rounded-[var(--r-1)] px-2 py-2 hover:bg-hover">
                            <span className="flex items-baseline gap-3">
                              <span className="font-mono text-[12.5px] text-fg">{ev}</span>
                              <span className="min-w-0 truncate text-[12px] text-fg-3">{g.matcher ? <span className="mono">{g.matcher}</span> : anyWords(ev as HookEvent)}</span>
                            </span>
                            <span className="mt-0.5 block font-mono text-[12px] [overflow-wrap:anywhere] text-fg-2" title={h.command ?? h.prompt}>
                              {withPluginRoot(h.command ?? h.prompt ?? '', root)}
                            </span>
                          </Link>
                          </div>
                        );
                      }),
                    ),
                  )}
                </div>
              </Block>
            )}
            {servers.length > 0 && (
              <Block title="MCP servers" count={servers.length}>
                <div className="rows">
                  {servers.map(([n, cfg]) => {
                    const st = mcp.find((s) => s.name === n);
                    return (
                      <div key={n}>
                      <Link href={`/extensions/mcp?server=${encodeURIComponent(n)}`} className="-mx-2 flex items-baseline gap-3 rounded-[var(--r-1)] px-2 py-2 hover:bg-hover">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12.5px] text-fg">{n}</span>
                          <span className="mt-0.5 block truncate font-mono text-[12px] text-fg-3">{cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(' ')}</span>
                        </span>
                        <span className="shrink-0 text-[13px]">
                          {statusWord(st, d.enabled)}
                          {st?.status === 'connected' && <span className="text-fg-3">, {plural(st.tools, 'tool')}</span>}
                        </span>
                      </Link>
                      </div>
                    );
                  })}
                </div>
              </Block>
            )}

            <Block title="Install in other CLIs">
              {mk ? (
                <div className="mt-3 space-y-4">
                  <div>
                    <HarnessName harness="claude-code" size={14} className="text-[13px] font-medium text-fg" />
                    <Command className="mt-1.5" copy command={`claude plugin install ${d.name}@${mk}`} />
                    {KNOWN_MARKETPLACES[mk] && (
                      <p className="mt-1.5 mb-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                        If Claude Code does not know {mk} yet, run <span className="mono">claude plugin marketplace add {KNOWN_MARKETPLACES[mk]}</span> first.
                      </p>
                    )}
                  </div>
                  <div>
                    <HarnessName harness="codex" size={14} className="text-[13px] font-medium text-fg" />
                    <Command className="mt-1.5" copy command={`codex plugin add ${d.name}@${mk}`} />
                    {KNOWN_MARKETPLACES[mk] && (
                      <p className="mt-1.5 mb-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                        Codex reads the same plugin. Add the marketplace with <span className="mono">codex plugin marketplace add https://github.com/{KNOWN_MARKETPLACES[mk]}.git</span> if it is new there.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-3 mb-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
                  This plugin was installed from <span className="mono">{d.source}</span>, not a marketplace. Claude Code and Codex install plugins from a marketplace: add one that lists {d.name}, then install it there.
                </p>
              )}
            </Block>
          </>
        )}
      </Drawer>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${d?.name ?? ''}?`}
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (!d) return;
          if (await attempt(() => api().removePlugin(d.name))) {
            toast({ title: `${d.name} removed.` });
            onChanged();
            onClose();
          }
        }}
      >
        {d && (
          <>
            <p className="m-0">
              Its {adds.length ? adds.join(', ') : 'parts'} go away. Its folder and its data folder are deleted:
            </p>
            <p className={cn('mt-2 mb-0 font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg')}>{d.dir}</p>
            <p className="mt-0.5 mb-0 font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg">{dataFolder(d)}</p>
            <p className="mt-2 mb-0">Sessions that used it keep their history.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
