/**
 * Settings > Connected apps: chatbots that signed in to /mcp with OAuth
 * (claude.ai, ChatGPT, Claude Code), what each may do, when it was added and
 * last used, and Revoke. Under them, how to add Conclave to a chatbot: the
 * URL to paste and the line for its custom instructions.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { ConnectedAppDto, OAuthScope } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile, useLoad, useNow } from '@/lib/hooks';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/text';
import { attempt, toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { Table, type Column } from '@/components/ui/Table';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { outsideAddress } from '@/lib/remote';
import { useRemote } from './remote';
import { agoWords, errText, Group } from './parts';

/** Short words for a table cell; the consent screen uses the long ones. */
const SHORT: Record<OAuthScope, string> = {
  'memory:read': 'read memory',
  'memory:write': 'save and forget memories',
  'chats:read': 'search chats',
};

export const MEMORY_CONTEXT_LINE = "At the start of every chat, call Conclave's memory_context.";

function can(a: ConnectedAppDto): string {
  return a.scopes.map((s) => SHORT[s.id]).join(', ');
}

function domain(a: ConnectedAppDto): string {
  return a.identity && a.identity !== a.host ? `${a.host}, from ${a.identity}` : a.host;
}

export function AppsSection() {
  const mobile = useIsMobile();
  const apps = useLoad(() => api().connectedApps(), []);
  const now = useNow(60_000);
  const [revoke, setRevoke] = useState<ConnectedAppDto | null>(null);
  const list = apps.data ?? [];

  const cols: Column<ConnectedAppDto>[] = [
    { key: 'name', header: 'Name', title: true, render: (a) => a.name },
    { key: 'domain', header: 'Domain', dim: true, render: (a) => <span className="font-mono text-[12px]">{domain(a)}</span> },
    { key: 'can', header: 'Can', dim: true, render: (a) => can(a) },
    { key: 'created', header: 'Added', dim: true, phoneHide: true, render: (a) => <span className="num">{shortDate(a.createdAt)}</span> },
    { key: 'used', header: 'Last used', dim: true, render: (a) => (a.lastUsedAt ? <span className="num">{agoWords(a.lastUsedAt, now)}</span> : 'not yet') },
    {
      key: 'revoke',
      header: <span className="sr-only">Revoke</span>,
      className: 'r',
      render: (a) => (
        <Button variant="danger" size="sm" className="-my-1 -mr-2" onClick={() => setRevoke(a)}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-9">
      <Group title="Apps" count={apps.data ? list.length : undefined} rows={false} help="They reach your memory through /mcp with their own sign in. Each one can only do what you allowed.">
        <LoadingRows loading={apps.loading && !apps.data} rows={3} />
        {apps.error && !apps.data && <p className="t-body mt-3 text-fault">Could not load the apps. {errText(apps.error)}</p>}
        {apps.data &&
          (mobile && list.length > 0 ? (
            <div className="rows">
              {list.map((a) => (
                <div key={a.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium text-fg">
                      {a.name} <span className="font-mono text-[12.5px] font-normal text-fg-3">{a.host}</span>
                    </div>
                    <div className="mt-0.5 text-[13px] leading-[1.4] text-fg-3">
                      Can {can(a)}. {a.lastUsedAt ? `Used ${agoWords(a.lastUsedAt, now)}` : 'Not used yet'}, added {shortDate(a.createdAt)}.
                    </div>
                  </div>
                  <Button variant="danger" size="touch" className="-mr-3" onClick={() => setRevoke(a)}>
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Table
              caption="Connected apps"
              columns={cols}
              rows={list}
              rowKey={(a) => a.id}
              empty={<EmptyState wave={false}>No apps yet. Add Conclave as a connector in claude.ai or ChatGPT, then allow it on the Conclave page that opens.</EmptyState>}
            />
          ))}
      </Group>

      <AddToChatbot />

      <ConfirmDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={`Revoke ${revoke?.name}?`}
        body={`It loses access to your memory right away. To use it again, connect it again from ${revoke?.host}.`}
        confirm="Revoke"
        busy="Revoking"
        onConfirm={async () => {
          if (revoke && (await attempt(() => api().revokeConnectedApp(revoke.id)))) {
            apps.reload();
            toast({ title: `${revoke.name} revoked.` });
          }
        }}
      />
    </div>
  );
}

function AddToChatbot() {
  const { status } = useRemote();
  const out = outsideAddress(status);
  const stable = out && (out.kind === 'stable' || (out.kind === 'own' && out.url.startsWith('https://')));
  const url = out ? `${out.url.replace(/\/+$/, '')}/mcp` : undefined;
  return (
    <Group title="Add Conclave to a chatbot" rows={false}>
      <div className="space-y-5 pt-3">
        {url ? (
          <div>
            <p className="t-body text-fg-2">Paste this address as a custom connector. In claude.ai: Customize, Connectors, Add custom connector. In ChatGPT: Settings, Apps, then Create app (Developer mode on).</p>
            <CodeBlock className="mt-2.5" code={url} title="Connector URL" wrap />
          </div>
        ) : null}
        {!stable && (
          <p className={cn('t-body', out ? 'text-warn' : 'text-fg-2')}>
            {out
              ? 'This is a quick tunnel address. It changes when the hub restarts, and the connector stops working. Set up a stable address first.'
              : 'claude.ai and ChatGPT reach the hub from the internet, so it needs a stable https address first.'}{' '}
            <Link href="/settings/remote" className="text-fg underline underline-offset-[3px]">
              Remote access
            </Link>
          </p>
        )}
        {stable && out?.kind === 'own' && /\.ts\.net/i.test(out.url) && (
          <p className="t-body text-warn">A Tailscale address only works from claude.ai and ChatGPT with Tailscale Funnel turned on.</p>
        )}
        <div>
          <p className="t-body text-fg-2">Then add this line to the chatbot's custom instructions, so it reads your memory first:</p>
          <CodeBlock className="mt-2.5" code={MEMORY_CONTEXT_LINE} title="Custom instruction" wrap />
        </div>
      </div>
    </Group>
  );
}
