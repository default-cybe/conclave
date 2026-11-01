/**
 * Settings > Appearance, Audit log and About (spec 11.10).
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { AuditEntry } from '@conclave/core/types';
import { api, clearConnection, loadConnection, MOCK } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { useUi, type Density, type LogoTone, type MotionPref, type Theme } from '@/store/ui';
import { TEXT_SIZES, type TextSize } from '@/lib/textSize';
import { useIsMobile, useLoad, useNow } from '@/lib/hooks';
import { durationShort, hhmm, shortDate } from '@/lib/format';
import { RUN_SETUP_AGAIN } from '@/lib/onboarding';
import { disablePush } from '@/lib/push';
import { transportWords } from '@/lib/remote';
import { Button } from '@/components/ui/Button';
import { Input, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Table, type Column } from '@/components/ui/Table';
import { TextAction } from '@/components/ui/Section';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { Logo, LOGO_NOTICE, LOGOS } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { version as CLIENT_VERSION } from '../../../package.json';
import { Group, Outcome, save, SettingRow } from './parts';
import { BackupDialog, RestoreDialog } from './backup';
import { ImportSheet } from '@/features/import/ImportSheet';
import { openImportSheet } from '@/features/import/store';
import { useIsOwner } from '@/lib/people';
import { UpdatesGroup } from './updates';
import { tauriInvoke } from './computer';

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export function AppearanceSection() {
  const mobile = useIsMobile();
  const theme = useUi((s) => s.theme);
  const logos = useUi((s) => s.logos);
  const density = useUi((s) => s.density);
  const motion = useUi((s) => s.motion);
  const textSize = useUi((s) => s.textSize);
  const set = useUi((s) => s.set);
  // a member's greeting is their display name, set in Your account; the hub's ui.name is the owner's
  const owner = useIsOwner();
  const size = mobile ? 'touch' : 'sm';
  return (
    <div className="space-y-9">
      <Group title="This device">
        <SettingRow label="Theme" help="System follows the light or dark setting of this device.">
          <Segmented<Theme>
            label="Theme"
            size={size}
            value={theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Logos"
          help={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Brand colors where the model or provider is the subject of a row.</span>
              <span className="inline-flex items-center gap-[5px]">
                {(['claude', 'gpt', 'gemini', 'glm', 'deepseek', 'qwen'] as const).map((id) => (
                  <Logo key={id} id={id} size={16} tone="brand" label={LOGOS[id].name} />
                ))}
              </span>
            </span>
          }
        >
          <Segmented<LogoTone>
            label="Logos"
            size={size}
            value={logos}
            onChange={(v) => set({ logos: v })}
            options={[
              { value: 'brand', label: 'Brand colors' },
              { value: 'mono', label: 'One color' },
            ]}
          />
        </SettingRow>
        <TextSizeRow value={textSize} onChange={(v) => set({ textSize: v })} size={size} />
        <SettingRow label="Density" help="Compact tightens rows and uses 13px body text.">
          <Segmented<Density>
            label="Density"
            size={size}
            value={density}
            onChange={(v) => set({ density: v })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Reduce motion" help="On keeps the mark and the wave still and turns off transitions. System follows this device.">
          <Segmented<MotionPref>
            label="Reduce motion"
            size={size}
            value={motion}
            onChange={(v) => set({ motion: v })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'reduce', label: 'On' },
            ]}
          />
        </SettingRow>
      </Group>
      <Group title="Every device">
        {owner ? (
          <NameRow />
        ) : (
          <SettingRow label="Your name" help="Home greets you by your display name.">
            <Link href="/settings/account" className="link text-[13px]">
              Your account
            </Link>
          </SettingRow>
        )}
      </Group>
    </div>
  );
}

/**
 * Text size: the conversation's text (replies, your messages, tool rows,
 * code) from Small to Larger, on this device. The line under the label is
 * a reply at the size picked, so the choice shows at once
 * (lib/textSize.ts, CHAT-AND-MOTION 6.5).
 */
export function TextSizeRow({ value, onChange, size }: { value: TextSize; onChange: (v: TextSize) => void; size: 'touch' | 'sm' }) {
  return (
    <SettingRow
      label="Text size"
      help={
        <>
          Replies, your messages, tool rows and code. The rest of the app stays as it is.
          <span data-text-preview="" className="log-text t-chat mt-2 block text-fg">
            A reply reads at this size.
          </span>
        </>
      }
    >
      <Segmented<TextSize> label="Text size" size={size} value={value} onChange={onChange} options={TEXT_SIZES.map((t) => ({ value: t.value, label: t.label }))} />
    </SettingRow>
  );
}

/** The name the Chat page greets the owner with ("Good evening, Kai."). Kept in the hub config as ui.name; the hub sets it when the owner's display name changes. */
function NameRow() {
  const mobile = useIsMobile();
  const saved = useHub((s) => {
    const v = (s.config?.ui as { name?: unknown } | undefined)?.name;
    return typeof v === 'string' ? v : '';
  });
  const [name, setName] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(saved), [saved]);
  const dirty = name.trim() !== saved.trim();
  const submit = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    await save({ ui: { name: name.trim() } });
    setBusy(false);
  };
  return (
    <SettingRow label="Your name" htmlFor="ui-name" help="The Chat page greets you by it. Leave it empty for no name.">
      <form
        className="flex w-full items-center justify-end gap-2 md:max-w-[320px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input id="ui-name" size="sm" value={name} maxLength={60} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="Kai" className="min-w-0 flex-1" />
        {dirty && (
          <Button type="submit" variant="solid" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Saving' : false}>
            Save
          </Button>
        )}
      </form>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function csv(rows: AuditEntry[], sessionTitle: (id?: string) => string, deviceName: (id?: string) => string) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['time', 'actor', 'action', 'detail', 'device', 'session'];
  const lines = rows.map((r) => [new Date(r.ts).toISOString(), r.actor, r.action, r.detail, deviceName(r.device), sessionTitle(r.sessionId)].map((v) => esc(v ?? '')).join(','));
  return [head.join(','), ...lines].join('\n');
}

export function AuditSection() {
  const mobile = useIsMobile();
  const audit = useLoad(() => api().audit({ limit: 500 }), []);
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const [device, setDevice] = useState('');
  const [session, setSession] = useState('');
  const all = audit.data ?? [];
  const rows = all.filter((r) => (!device || r.device === device) && (!session || r.sessionId === session));
  const deviceName = (id?: string) => (id ? (devices[id]?.name ?? id) : '');
  const sessionTitle = (id?: string) => (id ? (sessions[id]?.title ?? id) : '');
  const deviceIds = [...new Set(all.map((r) => r.device).filter(Boolean))] as string[];
  const sessionIds = [...new Set(all.map((r) => r.sessionId).filter(Boolean))] as string[];

  const download = () => {
    const blob = new Blob([csv(rows, sessionTitle, deviceName)], {
      type: 'text/csv',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conclave-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const cols: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: 'Time',
      dim: true,
      width: 110,
      render: (r) => (
        <span className="num whitespace-nowrap">
          {shortDate(r.ts)}, {hhmm(r.ts)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Who',
      title: true,
      width: 120,
      render: (r) => r.actor.replace(/\s*·\s*/g, ', '),
    },
    {
      key: 'action',
      header: 'Action',
      width: 170,
      render: (r) => <span className="font-mono text-[12px] text-fg">{r.action}</span>,
    },
    {
      key: 'detail',
      header: 'Detail',
      dim: true,
      className: 'truncate',
      render: (r) => <span title={r.detail}>{r.detail}</span>,
    },
    {
      key: 'device',
      header: 'Device',
      dim: true,
      width: 110,
      phoneHide: true,
      render: (r) => deviceName(r.device),
    },
    {
      key: 'session',
      header: 'Session',
      width: 180,
      phoneHide: true,
      className: 'truncate',
      render: (r) =>
        r.sessionId ? (
          <Link href={`/s/${r.sessionId}`} className="link text-fg-2" title={sessionTitle(r.sessionId)}>
            {sessionTitle(r.sessionId)}
          </Link>
        ) : (
          ''
        ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-rule-2 pb-2 phone:pb-0 phone:[&_button]:min-h-11">
        <SelectMenu
          look="text"
          prefix="Device"
          label="Device"
          value={device}
          onChange={setDevice}
          width={220}
          options={[
            { value: '', label: 'any', text: 'any' },
            ...deviceIds.map((d) => ({
              value: d,
              label: deviceName(d),
              text: deviceName(d),
            })),
          ]}
        />
        <span aria-hidden className="h-3.5 w-px bg-rule" />
        <SelectMenu
          look="text"
          prefix="Session"
          label="Session"
          value={session}
          onChange={setSession}
          width={300}
          options={[
            { value: '', label: 'any', text: 'any' },
            ...sessionIds.map((s) => ({
              value: s,
              label: sessionTitle(s),
              text: sessionTitle(s),
            })),
          ]}
        />
        <span className="ml-auto flex items-baseline gap-4">
          <span className="num text-[12px] text-fg-3">
            {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
          </span>
          {!mobile && <TextAction label="Export CSV" onClick={download} />}
        </span>
      </div>
      <LoadingRows loading={audit.loading && !audit.data} rows={6} />
      {audit.data && (
        <Table
          caption="Audit log"
          className="table-fixed"
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState wave={false}>{all.length ? 'Nothing matches these filters.' : 'Nothing logged yet. Approvals, tool calls, pairings and settings changes show up here.'}</EmptyState>}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------


function clientWords(): string {
  const w = window as unknown as Record<string, unknown>;
  if ('__TAURI_INTERNALS__' in w || '__TAURI__' in w) return /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone app' : 'Desktop app';
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const installed = window.matchMedia?.('(display-mode: standalone)').matches;
  return `${browser}${os ? ` on ${os}` : ''}${installed ? ', installed' : ''}`;
}

/** What the desktop app's update_status returns (View in packages/desktop/src-tauri/src/update.rs). */
export interface AppUpdate {
  available?: string | null;
  installing: boolean;
  error?: string | null;
  off?: string | null;
  current: string;
}

/** The desktop app's own version and update, or undefined outside it (or in an app too old to tell the hub page). */
export async function readAppUpdate(): Promise<AppUpdate | undefined> {
  try {
    return await tauriInvoke()?.<AppUpdate>('update_status');
  } catch {
    return undefined;
  }
}

/** The "App" row of This client: the desktop app's real version and its update, else the web bundle's. */
export function ClientAppRow({ words, app, size, onUpdate }: { words: string; app?: AppUpdate; size: 'touch' | 'sm'; onUpdate: () => void }) {
  const error = app?.error ? (app.error.startsWith('The update did not install') ? app.error : `The app could not check for updates: ${app.error}`) : undefined;
  return (
    <SettingRow label="App" help={error}>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 md:justify-end">
        <span className="text-[14px] text-fg">
          {words}, <span className="font-mono text-[13px]">{app?.current || CLIENT_VERSION}</span>
        </span>
        {app?.available && (
          <Button variant="outline" size={size} busy={app.installing ? 'Installing' : false} onClick={onUpdate}>
            Update to {app.available}
          </Button>
        )}
      </span>
    </SettingRow>
  );
}

export function AboutSection() {
  const mobile = useIsMobile();
  const owner = useIsOwner();
  const [, navigate] = useLocation();
  const hub = useHub((s) => s.hub);
  const conn = useHub((s) => s.conn);
  const now = useNow(60_000);
  const base = loadConnection()?.baseUrl ?? (MOCK ? location.origin : undefined);
  const [latency, setLatency] = useState<number | 'testing' | 'failed'>('testing');
  const [backup, setBackup] = useState<'download' | 'restore' | null>(null);
  const [signOut, setSignOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [app, setApp] = useState<AppUpdate>();
  const size = mobile ? 'touch' : 'sm';

  const loadApp = () => void readAppUpdate().then(setApp);
  useEffect(loadApp, []);
  // update_install restarts the app when it works; when it fails, the error shows in the row
  const updateApp = () => {
    if (app) setApp({ ...app, installing: true });
    void attempt(async () => tauriInvoke()?.('update_install')).then(loadApp);
  };

  const ping = async () => {
    setLatency('testing');
    const t0 = performance.now();
    try {
      await api().info();
      setLatency(Math.max(1, Math.round(performance.now() - t0)));
    } catch {
      setLatency('failed');
    }
  };
  useEffect(() => {
    void ping();
  }, []);

  const run = async (id: string, fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(id);
    const r = await attempt(fn);
    setBusy(null);
    if (r !== undefined) toast({ title: ok(r as never) });
  };

  return (
    <div className="space-y-9">
      <Group title="Hub">
        <SettingRow label="Name">
          <span className="text-[14px] text-fg">{hub?.name ?? 'Unknown'}</span>
        </SettingRow>
        <SettingRow label="Version">
          <span className="font-mono text-[13px] text-fg">{hub?.version ?? 'unknown'}</span>
        </SettingRow>
        <SettingRow label="Address" help={hub?.publicUrl && hub.publicUrl !== base ? 'Phones use the public address in pairing codes.' : undefined}>
          <span className="flex flex-col items-start gap-0.5 md:items-end">
            <span className="font-mono text-[13px] break-all text-fg">{base ?? 'Not connected'}</span>
            {hub?.publicUrl && hub.publicUrl !== base && <span className="font-mono text-[12px] break-all text-fg-3">{hub.publicUrl}</span>}
          </span>
        </SettingRow>
        <SettingRow label="Up for">
          <span className="num text-[14px] text-fg">{hub ? durationShort(now - hub.startedAt) : 'unknown'}</span>
        </SettingRow>
        {hub?.features?.length ? (
          <SettingRow label="Features" help="What this hub was built with.">
            <span className="text-[13px] text-fg-2 md:text-right">{hub.features.join(', ')}</span>
          </SettingRow>
        ) : null}
      </Group>

      {/* the hub's updates are the owner's (docs/DESIGN.md, Updates) */}
      {owner && <UpdatesGroup />}

      <Group title="This client">
        <ClientAppRow words={clientWords()} app={app} size={size} onUpdate={updateApp} />
        <SettingRow label="Connection" help={MOCK ? 'Showing mock data, not a real hub.' : undefined}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 md:justify-end">
            <span className="text-[14px] text-fg">{transportWords(base)}</span>
            {latency === 'testing' ? (
              <LiveStatus state="tool" label="Measuring" />
            ) : latency === 'failed' ? (
              <Outcome word="No answer" tone="fault" />
            ) : (
              <span className="text-[13px] text-fg-3">
                <span className="num">{latency}</span> ms
              </span>
            )}
            <TextAction label="Again" onClick={() => void ping()} />
          </span>
        </SettingRow>
        <SettingRow label="Live updates">
          <span className="text-[14px]">
            {conn === 'open' ? <span className="text-ok">connected</span> : conn === 'connecting' ? <span className="text-fg-3">reconnecting</span> : <span className="text-fault">offline</span>}
          </span>
        </SettingRow>
      </Group>

      <Group title="Setup">
        <SettingRow label="Run setup again" help="Walks through providers, agents, defaults, devices and routines with your answers filled in.">
          <Button variant="outline" size={size} onClick={() => navigate(RUN_SETUP_AGAIN)}>
            Run setup again
          </Button>
        </SettingRow>
        <SettingRow label="Import past chats" help="Claude Code, Codex and Gemini CLI chats on your machines, or a claude.ai or ChatGPT export. Import them as archived sessions, learn memory from them, or both.">
          <Button variant="outline" size={size} onClick={() => openImportSheet()}>
            Import past chats
          </Button>
        </SettingRow>
        <SettingRow label="Reload from disk" help="Agents, skills, commands and plugins, after you edit them by hand.">
          <Button
            variant="outline"
            size={size}
            busy={busy === 'reload' ? 'Reloading' : false}
            onClick={() =>
              void run(
                'reload',
                () => api().reloadExtensions(),
                () => 'Reloaded agents, skills, commands and plugins.',
              )
            }
          >
            Reload
          </Button>
        </SettingRow>
        <SettingRow label="Sync to CLIs" help="Write your agents and memory into Claude Code and Codex config on the hub.">
          <Button
            variant="outline"
            size={size}
            busy={busy === 'sync' ? 'Syncing' : false}
            onClick={() =>
              void run(
                'sync',
                () => api().syncToClis(),
                (r: { written: string[] }) => (r.written?.length ? `Wrote ${r.written.join(', ')}.` : 'Nothing needed writing.'),
              )
            }
          >
            Sync
          </Button>
        </SettingRow>
      </Group>

      <Group title="Backup">
        <SettingRow label="Download a backup" help="Settings, agents, routines, tasks, memory and sessions in one file. Keys stay out unless you add them.">
          <Button variant="outline" size={size} onClick={() => setBackup('download')}>
            Download
          </Button>
        </SettingRow>
        <SettingRow label="Restore from a backup" help="Adds the sessions, notes and tasks this hub does not have. Settings, agents and routines from the file replace the ones here.">
          <Button variant="outline" size={size} onClick={() => setBackup('restore')}>
            Restore
          </Button>
        </SettingRow>
      </Group>

      <Group title="This device">
        <SettingRow label="Sign out of this hub" help="Forgets the address and token here. The hub and its sessions keep running.">
          <Button variant="danger" size={size} onClick={() => setSignOut(true)}>
            Sign out
          </Button>
        </SettingRow>
      </Group>

      <p className="max-w-[64ch] border-t border-rule pt-4 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{LOGO_NOTICE}</p>

      <ImportSheet />
      <BackupDialog open={backup === 'download'} onClose={() => setBackup(null)} />
      <RestoreDialog open={backup === 'restore'} onClose={() => setBackup(null)} />
      <ConfirmDialog
        open={signOut}
        onClose={() => setSignOut(false)}
        title={`Sign out of ${hub?.name ?? 'this hub'}?`}
        body="This device forgets the address and token. Pair it again or paste the token to come back."
        confirm="Sign out"
        busy="Signing out"
        onConfirm={async () => {
          // while the token still works: this browser stops getting the hub's notifications
          await disablePush().catch(() => undefined);
          // the page must not leave before the service worker's copy of the token is deleted
          await clearConnection();
          location.href = '/';
        }}
      />
    </div>
  );
}
