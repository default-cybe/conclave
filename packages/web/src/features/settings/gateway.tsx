/**
 * Settings > Gateway keys (spec 11.10): one key per CLI and device so usage
 * is tracked per machine and one key can be revoked alone. A new key is shown
 * once, with the lines to paste for each CLI. Each gateway route (one per
 * API shape) can be turned off on its own.
 */
import { useState, type ReactNode } from 'react';
import type { GatewayKeyDto } from '@conclave/core/client';
import { api, loadConnection } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { useIsMobile, useLoad, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { shortDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input, OnOff } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { Tabs } from '@/components/ui/Tags';
import { Table, type Column } from '@/components/ui/Table';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { agoWords, Group, save, SettingRow } from './parts';

type Cli = 'claude' | 'codex' | 'opencode';

type RouteId = 'anthropic' | 'openai' | 'gemini' | 'provider';

/** The hub's gateway routes (server/src/gateway), each with an on or off switch in config gateway.routes. */
const ROUTES: Array<{ id: RouteId; path: string; help: ReactNode }> = [
  { id: 'anthropic', path: '/gw/anthropic', help: 'Claude Code and other clients of the Anthropic API.' },
  { id: 'openai', path: '/gw/openai', help: 'Codex, OpenCode and other clients of the OpenAI API.' },
  { id: 'gemini', path: '/gw/gemini', help: 'Gemini CLI and other clients of the Gemini API.' },
  {
    id: 'provider',
    path: '/gw/p/<provider>',
    help: (
      <>
        Any provider set up on the hub, by its id, such as <span className="mono">/gw/p/zai</span>.
      </>
    ),
  },
];

function Routes() {
  const mobile = useIsMobile();
  const routes = useHub((s) => (s.config?.gateway as { routes?: Partial<Record<RouteId, boolean>> } | undefined)?.routes);
  const off = ROUTES.filter((r) => routes?.[r.id] === false).length;
  return (
    <Group title="Routes" count={off ? `${off} off` : undefined} help="Each route speaks one API. A CLI that calls a route you turned off gets an error that says so, until you turn it back on.">
      {ROUTES.map((r) => (
        <SettingRow key={r.id} label={<span className="font-mono text-[12.5px] font-normal phone:text-[14px]">{r.path}</span>} help={r.help}>
          <OnOff label={`${r.path} route`} checked={routes?.[r.id] !== false} onChange={(v) => void save({ gateway: { routes: { [r.id]: v } } })} size={mobile ? 'touch' : 'sm'} />
        </SettingRow>
      ))}
    </Group>
  );
}

function hubUrl() {
  const conn = loadConnection();
  return (useHub.getState().hub?.publicUrl ?? conn?.baseUrl ?? window.location.origin).replace(/\/+$/, '');
}

function snippet(cli: Cli, hub: string, key: string): { lang: string; code: string; where: string } {
  if (cli === 'claude')
    return {
      lang: 'shell',
      where: 'In your shell profile, on the machine that runs Claude Code.',
      code: `export ANTHROPIC_BASE_URL="${hub}/gw/anthropic"\nexport ANTHROPIC_AUTH_TOKEN="${key}"`,
    };
  if (cli === 'codex')
    return {
      lang: 'toml',
      where: 'In ~/.codex/config.toml, and CONCLAVE_KEY in your shell profile.',
      code: `model_provider = "conclave"\n\n[model_providers.conclave]\nname = "Conclave"\nbase_url = "${hub}/gw/openai/v1"\nenv_key = "CONCLAVE_KEY"\n\n# shell profile\n# export CONCLAVE_KEY="${key}"`,
    };
  return {
    lang: 'json',
    where: 'In opencode.json, in the project or in ~/.config/opencode.',
    code: `{\n  "provider": {\n    "conclave": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "${hub}/gw/openai/v1", "apiKey": "${key}" }\n    }\n  }\n}`,
  };
}

function Snippets({ keyText }: { keyText: string }) {
  const [cli, setCli] = useState<Cli>('claude');
  const s = snippet(cli, hubUrl(), keyText);
  return (
    <div>
      <Tabs
        label="CLI"
        value={cli}
        onChange={setCli}
        options={[
          { value: 'claude', label: 'Claude Code' },
          { value: 'codex', label: 'Codex' },
          { value: 'opencode', label: 'OpenCode' },
        ]}
      />
      <p className="mt-2.5 mb-2 text-[12px] text-fg-3 phone:text-[13px]">{s.where}</p>
      <CodeBlock key={cli} code={s.code} lang={s.lang} />
    </div>
  );
}

export function GatewaySection() {
  const mobile = useIsMobile();
  const keys = useLoad(() => api().gatewayKeys(), []);
  const devices = useHub((s) => s.devices);
  const now = useNow(60_000);
  const [create, setCreate] = useState(false);
  const [revoke, setRevoke] = useState<GatewayKeyDto | null>(null);
  const list = [...(keys.data ?? [])].sort((a, b) => Number(a.revoked) - Number(b.revoked) || b.createdAt - a.createdAt);

  const cols: Column<GatewayKeyDto>[] = [
    {
      key: 'name',
      header: 'Name',
      title: true,
      render: (k) => (
        <span className={cn(k.revoked && 'text-fg-3')}>
          {k.name}
          <span className="ml-2 font-mono text-[11.5px] font-normal text-fg-3">{k.prefix}</span>
        </span>
      ),
    },
    {
      key: 'device',
      header: 'Device',
      dim: true,
      render: (k) => (k.device ? (devices[k.device]?.name ?? k.device) : 'any device'),
    },
    {
      key: 'agent',
      header: 'Agent',
      dim: true,
      phoneHide: true,
      render: (k) => k.agent ?? 'any agent',
    },
    {
      key: 'created',
      header: 'Created',
      dim: true,
      phoneHide: true,
      render: (k) => <span className="num">{shortDate(k.createdAt)}</span>,
    },
    {
      key: 'used',
      header: 'Last used',
      dim: true,
      render: (k) => (k.lastUsedAt ? <span className="num">{agoWords(k.lastUsedAt, now)}</span> : 'never'),
    },
    {
      key: 'revoke',
      header: <span className="sr-only">Revoke</span>,
      className: 'r',
      render: (k) =>
        k.revoked ? (
          <span className="text-fg-3">revoked</span>
        ) : (
          <Button variant="danger" size="sm" className="-my-1 -mr-2" onClick={() => setRevoke(k)}>
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-9">
      <Group title="Keys" count={list.filter((k) => !k.revoked).length} action={{ label: 'New key', onClick: () => setCreate(true) }} rows={false}>
        <LoadingRows loading={keys.loading && !keys.data} rows={3} />
        {keys.data && (
          <>
            {mobile && list.length > 0 ? (
              <div className="rows">
                {list.map((k) => (
                  <div key={k.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-[15px] font-medium', k.revoked ? 'text-fg-3' : 'text-fg')}>
                        {k.name} <span className="font-mono text-[12px] font-normal text-fg-3">{k.prefix}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-fg-3">
                        {k.device ? (devices[k.device]?.name ?? k.device) : 'any device'}, {k.lastUsedAt ? `used ${agoWords(k.lastUsedAt, now)}` : 'never used'}
                      </div>
                    </div>
                    {k.revoked ? (
                      <span className="text-[13px] text-fg-3">revoked</span>
                    ) : (
                      <Button variant="danger" size="touch" className="-mr-3" onClick={() => setRevoke(k)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Table
                caption="Gateway keys"
                columns={cols}
                rows={list}
                rowKey={(k) => k.id}
                empty={
                  <EmptyState wave={false} action={{ label: 'New key', onClick: () => setCreate(true) }}>
                    No keys yet. Make one per CLI and machine, so you can see which one spends what and revoke it alone.
                  </EmptyState>
                }
              />
            )}
          </>
        )}
      </Group>

      <Routes />

      <Group title="Point a CLI at the hub" help="Its usage then shows up under Gateway on the Usage page, and its limits are tracked with the rest." rows={false}>
        <div className="pt-3">
          <Snippets keyText="<your key>" />
        </div>
      </Group>

      <NewKeyDialog open={create} onClose={() => setCreate(false)} onCreated={() => keys.reload()} />
      <ConfirmDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={`Revoke ${revoke?.name}?`}
        body="Every CLI that uses this key stops reaching the hub right away. Its past usage stays."
        confirm="Revoke"
        busy="Revoking"
        onConfirm={async () => {
          if (revoke && (await attempt(() => api().revokeGatewayKey(revoke.id)))) {
            keys.reload();
            toast({ title: `${revoke.name} revoked.` });
          }
        }}
      />
    </div>
  );
}

function NewKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const mobile = useIsMobile();
  const devices = useHub((s) => s.devices);
  const agents = useHub((s) => s.agents);
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<(GatewayKeyDto & { key: string }) | null>(null);

  const close = () => {
    onClose();
    setTimeout(() => {
      setMade(null);
      setName('');
      setDevice('');
      setAgent('');
    }, 200);
  };

  const submit = async () => {
    setBusy(true);
    const k = await attempt(() =>
      api().createGatewayKey(name.trim(), {
        device: device || undefined,
        agent: agent || undefined,
      }),
    );
    setBusy(false);
    if (k) {
      setMade(k);
      onCreated();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={made ? `Key for ${made.name}` : 'New gateway key'}
      description={made ? 'Copy it now. It is shown only once.' : undefined}
      width={made ? 640 : 480}
      footer={
        made ? (
          <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={close}>
              Cancel
            </Button>
            <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!name.trim()} busy={busy ? 'Making' : false} onClick={() => void submit()}>
              Make key
            </Button>
          </>
        )
      }
    >
      {made ? (
        <div className="flex flex-col gap-5 pt-1">
          <CodeBlock code={made.key} title="Key" />
          <Snippets keyText={made.key} />
        </div>
      ) : (
        <form
          className="flex flex-col gap-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void submit();
          }}
        >
          <Field label="Name" help="Which CLI on which machine, so you know what to revoke.">
            <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="arch-desktop claude-code" />
          </Field>
          <Field label="Only from" optional>
            <SelectMenu
              label="Device"
              value={device}
              onChange={setDevice}
              options={[
                { value: '', label: 'Any device', text: 'Any device' },
                ...Object.values(devices).map((d) => ({
                  value: d.id,
                  label: d.name,
                  text: d.name,
                })),
              ]}
            />
          </Field>
          <Field label="Runs as agent" optional help="Its instructions, memory and permissions apply to this CLI's requests.">
            <SelectMenu
              label="Agent"
              value={agent}
              onChange={setAgent}
              options={[
                { value: '', label: 'No agent', text: 'No agent' },
                ...agents.map((a) => ({
                  value: a.name,
                  label: a.name,
                  text: a.name,
                  detail: a.description,
                })),
              ]}
              width={320}
            />
          </Field>
        </form>
      )}
    </Dialog>
  );
}
