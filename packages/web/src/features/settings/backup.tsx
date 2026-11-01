/**
 * Backup and restore (spec 11.10 About, 11.11 Welcome). A backup is one JSON
 * file from GET /api/backup: settings, agents, routines, tasks, memory and
 * sessions. Keys stay out unless the owner asks for them. Restoring posts the
 * file back; what this hub already has stays as it is.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { HubBackup, RestoreResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { loadAll, toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { hhmm, int, shortDate } from '@/lib/format';
import { providerName } from '@/lib/models';
import { useOnboarded } from '@/lib/onboarding';
import { Button } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { errText } from './parts';

/** Same name the hub puts in Content-Disposition. */
export function backupFileName(b: Pick<HubBackup, 'hub' | 'createdAt'>): string {
  const name = b.hub.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'hub';
  return `conclave-backup-${name}-${new Date(b.createdAt).toISOString().slice(0, 10)}.json`;
}

function saveFile(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** "A, B and C" */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const many = (n: number, one: string, more = `${one}s`) => `${int(n)} ${n === 1 ? one : more}`;

/** "16 Oct", or "16 Oct 2025" for a file from another year. */
function madeOn(ts: number): string {
  const y = new Date(ts).getFullYear();
  return y === new Date().getFullYear() ? shortDate(ts) : `${shortDate(ts)} ${y}`;
}

/** A setting inside a dialog: label and help on the left, the control at the right (under it on phones). */
function OptionRow({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-x-6 gap-y-2.5 py-3.5 phone:flex-col phone:items-start">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">{label}</div>
        <div className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{help}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export function BackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [sessions, setSessions] = useState(true);
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = () => {
    onClose();
    setError(undefined);
    // keys go in a file only when asked for each time
    setSecrets(false);
  };

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const b = await api().backup({ secrets, sessions });
      const name = backupFileName(b);
      saveFile(name, JSON.stringify(b));
      // one line: the file name does not fit beside the close button on a phone
      toast({ title: mobile ? 'Backup saved.' : `Saved ${name}.` });
      close();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Download a backup"
      description="Settings, agents, routines, tasks, memory and sessions in one JSON file."
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy ? 'Preparing' : false} onClick={() => void download()}>
            Download
          </Button>
        </>
      }
    >
      <div className="rows border-y border-rule">
        <OptionRow label="Sessions" help="Every session and chat with its messages. Leave them out for a smaller file.">
          <OnOff label="Include sessions" checked={sessions} onChange={setSessions} size={size} />
        </OptionRow>
        <OptionRow label="Keys and secrets" help="Provider keys, bot tokens and passwords from your settings. Anyone with the file can use them.">
          <OnOff label="Include keys and secrets" checked={secrets} onChange={setSecrets} size={size} />
        </OptionRow>
      </div>
      {error && (
        <p role="alert" className="mt-3 mb-0 text-[13px] text-fault phone:text-[14px]">
          {error}
        </p>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

type Step = { at: 'pick'; error?: string } | { at: 'ready'; file: string; backup: HubBackup; error?: string } | { at: 'done'; backup: HubBackup; result: RestoreResult };

/** What the file holds, one line per kind. */
function Contents({ b }: { b: HubBackup }) {
  // count the lists themselves: a hand edited or damaged file can have counts that are off, or lists that are missing
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const c = { agents: n(b.agents), routines: n(b.routines), tasks: n(b.tasks), memories: n(b.memories), sessions: n(b.sessions), messages: n(b.messages) };
  const rows: Array<[string, ReactNode]> = [
    ['Sessions', c.sessions ? `${int(c.sessions)}, with ${many(c.messages, 'message')}` : 'none'],
    ['Memory', c.memories ? many(c.memories, 'note') : 'none'],
    ['Routines', c.routines ? int(c.routines) : 'none'],
    ['Tasks', c.tasks ? int(c.tasks) : 'none'],
    ['Agents', c.agents ? int(c.agents) : 'none'],
    ['Keys', b.includesSecrets ? 'included' : 'not included'],
  ];
  return (
    <dl className="rows m-0 border-y border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-2 phone:py-2.5">
          <dt className="text-[13px] text-fg-3 phone:text-[14px]">{k}</dt>
          <dd className="m-0 text-right text-[13.5px] text-fg phone:text-[15px]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function resultSentence(r: RestoreResult): string {
  const parts = [
    r.restored.sessions ? many(r.restored.sessions, 'session') : '',
    r.restored.memories ? many(r.restored.memories, 'note') : '',
    r.restored.routines ? many(r.restored.routines, 'routine') : '',
    r.restored.tasks ? many(r.restored.tasks, 'task') : '',
    r.restored.agents ? many(r.restored.agents, 'agent') : '',
    r.secrets ? many(r.secrets, 'key') : '',
    r.config ? 'your settings' : '',
  ].filter(Boolean);
  return parts.length ? `Restored ${andList(parts)}.` : 'Nothing new to restore. This hub already has everything in the file.';
}

/**
 * Pick a backup file, see what is in it, restore it. `done` is the main
 * action once it worked ("Close" in Settings, "Open Home" on Welcome).
 */
export function RestoreDialog({ open, onClose, done }: { open: boolean; onClose: () => void; done?: (result: RestoreResult) => { label: string; run: () => void } }) {
  const mobile = useIsMobile();
  const btn = mobile ? 'touch' : 'md';
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [settings, setSettings] = useState(true);
  const [busy, setBusy] = useState(false);

  const close = () => {
    onClose();
    setTimeout(() => {
      setStep({ at: 'pick' });
      setSettings(true);
    }, 200);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      setStep({ at: 'pick', error: `${f.name} is not a JSON file. Pick the .json file that Download a backup saved.` });
      return;
    }
    const b = data as HubBackup;
    if (!b || typeof b !== 'object' || Array.isArray(b) || b.format !== 'conclave-backup') {
      setStep({ at: 'pick', error: `${f.name} is not a Conclave backup. Pick the .json file that Download a backup saved.` });
      return;
    }
    // the hub checks the version and every list; the file goes to it as it is
    setStep({ at: 'ready', file: f.name, backup: b });
  };

  const restore = async () => {
    if (step.at !== 'ready') return;
    setBusy(true);
    try {
      const result = await api().restore(step.backup, { config: settings });
      // reload first: the next step's action depends on the restored settings (set up or not)
      await loadAll({ transcripts: true }).catch(() => {});
      setStep({ at: 'done', backup: step.backup, result });
    } catch (e) {
      setStep({ ...step, error: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const chooser = (
    <input
      ref={input}
      type="file"
      accept=".json,application/json"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        void pick(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  const main = step.at === 'done' ? done?.(step.result) : undefined;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={step.at === 'done' ? 'Backup restored' : 'Restore from a backup'}
      description={step.at === 'pick' ? 'Pick a file that Download a backup saved. Sessions, notes and tasks this hub already has stay as they are.' : undefined}
      footer={
        step.at === 'pick' ? (
          <>
            <Button variant="quiet" size={btn} onClick={close}>
              Cancel
            </Button>
            <Button variant="solid" size={btn} onClick={() => input.current?.click()}>
              Choose a file
            </Button>
          </>
        ) : step.at === 'ready' ? (
          <>
            <Button variant="quiet" size={btn} className="mr-auto" onClick={() => input.current?.click()}>
              Choose another file
            </Button>
            {/* phones close the sheet with its X or a swipe; two buttons fit on one row */}
            {!mobile && (
              <Button variant="quiet" size={btn} onClick={close}>
                Cancel
              </Button>
            )}
            <Button variant="solid" size={btn} busy={busy ? 'Restoring' : false} onClick={() => void restore()}>
              Restore
            </Button>
          </>
        ) : (
          <Button
            variant="solid"
            size={btn}
            onClick={() => {
              close();
              main?.run();
            }}
          >
            {main?.label ?? 'Close'}
          </Button>
        )
      }
    >
      {chooser}
      {step.at === 'pick' && step.error && (
        <p role="alert" className="mt-1 mb-0 text-[13px] text-fault phone:text-[14px]">
          {step.error}
        </p>
      )}

      {step.at === 'ready' && (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            <span className="font-mono text-[12.5px] break-all text-fg">{step.file}</span>
            <br />
            From {typeof step.backup.hub?.name === 'string' ? step.backup.hub.name : 'a hub'}
            {typeof step.backup.createdAt === 'number' && (
              <>
                , {madeOn(step.backup.createdAt)} at <span className="num">{hhmm(step.backup.createdAt)}</span>
              </>
            )}
            .
          </p>
          <Contents b={step.backup} />
          <div className="rows border-b border-rule">
            <OptionRow label="Settings" help="Defaults, permissions, hooks, notifications and the rest replace the ones here. This hub keeps its own address and token.">
              <OnOff label="Restore settings" checked={settings} onChange={setSettings} size={mobile ? 'touch' : 'sm'} />
            </OptionRow>
          </div>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            Agents and routines in the file replace the ones here with the same name. Sessions, notes and tasks this hub already has stay as they are.{' '}
            {step.backup.includesSecrets ? 'Keys in the file replace the keys here.' : 'Keys are not in this file. Add them again in Providers after the restore.'}
          </p>
          {step.error && (
            <p role="alert" className="m-0 text-[13px] text-fault phone:text-[14px]">
              {step.error}
            </p>
          )}
        </div>
      )}

      {step.at === 'done' && <Done r={step.result} onLeave={close} />}
    </Dialog>
  );
}

function Done({ r, onLeave }: { r: RestoreResult; onLeave: () => void }) {
  const onboarded = useOnboarded();
  const skipped = r.skipped.sessions + r.skipped.memories + r.skipped.tasks;
  return (
    <div className="flex flex-col gap-3 text-[14px] leading-[1.5] phone:text-[15px]">
      <p className="m-0 text-fg">
        <span className="text-ok">Done.</span> {resultSentence(r)}
      </p>
      {skipped > 0 && (
        <p className="m-0 text-fg-2">
          {andList(
            [
              r.skipped.sessions ? many(r.skipped.sessions, 'session') : '',
              r.skipped.memories ? many(r.skipped.memories, 'note') : '',
              r.skipped.tasks ? many(r.skipped.tasks, 'task') : '',
            ].filter(Boolean),
          )}{' '}
          {skipped === 1 ? 'was' : 'were'} already here and stayed as {skipped === 1 ? 'it was' : 'they were'}.
        </p>
      )}
      {r.missingKeys.length > 0 && (
        <p className="m-0 text-fg-2">
          Add keys again for {andList(r.missingKeys.map((p) => providerName(p)))} in{' '}
          {/* before setup is done, Settings sends the owner back to setup; its Providers step takes keys too */}
          <Link href={onboarded ? '/settings/providers' : '/setup/providers'} className="link" onClick={onLeave}>
            Providers
          </Link>
          .
        </p>
      )}
      {/* only matters when the settings came in */}
      {r.config && r.redacted.length > 0 && (
        <p className="m-0 text-fg-3">
          {r.redacted.length === 1 ? 'This setting holds a secret and was' : 'These settings hold secrets and were'} left out of the file:{' '}
          {r.redacted.slice(0, 4).map((path, i) => (
            <span key={path}>
              {i > 0 && ', '}
              <span className="font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg-2 phone:text-[13.5px]">{path}</span>
            </span>
          ))}
          {r.redacted.length > 4 && ` and ${r.redacted.length - 4} more`}. {r.redacted.length === 1 ? 'Enter it again where you use it.' : 'Enter them again where you use them.'}
        </p>
      )}
    </div>
  );
}
