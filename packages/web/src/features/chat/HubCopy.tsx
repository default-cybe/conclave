/**
 * Move to hub and Move back (core projects/hubcopy.ts): the session menu's
 * items and their dialogs. Move to hub copies the session's whole folder to
 * the hub's projects drive and runs there; Move back shows what changed on
 * the hub, then copies it to the device.
 */
import { useEffect, useState } from 'react';
import type { HubBackPreview, HubCopyPreview, HubCopyRecord } from '@conclave/core/client';
import type { EngineEventEnvelope, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { bytes as size } from '@/lib/format';
import { attempt, onHubEvent } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { Dialog, type MenuItem } from '@/components/ui/Overlay';

type Progress = Extract<EngineEventEnvelope, { type: 'hubcopy.progress' }>;

/** Measured folders per session for the menu's detail line, a few minutes old at most (du on a big folder takes a while). */
const previews = new Map<string, { at: number; p: HubCopyPreview }>();

export function hubRecord(session: Session): HubCopyRecord | undefined {
  const r = session.meta?.hubCopy;
  return r && typeof r === 'object' ? (r as HubCopyRecord) : undefined;
}

function useProgress(sessionId: string): Progress | undefined {
  const [p, setP] = useState<Progress>();
  useEffect(() => onHubEvent((e) => void (e.type === 'hubcopy.progress' && e.sessionId === sessionId && setP(e))), [sessionId]);
  return p;
}

/** The preview for the menu and the dialog; measured when the menu opens. */
function usePreview(session: Session, when: boolean): HubCopyPreview | undefined {
  const [p, setP] = useState(() => previews.get(session.id)?.p);
  useEffect(() => {
    if (!when || session.kind === 'chat') return;
    const hit = previews.get(session.id);
    if (hit && Date.now() - hit.at < 3 * 60_000) return setP(hit.p);
    let live = true;
    api()
      .hubCopyPreview(session.id)
      .then((v) => {
        previews.set(session.id, { at: Date.now(), p: v });
        if (live) setP(v);
      })
      .catch(() => undefined);
    return () => void (live = false);
  }, [session.id, session.kind, when]);
  return p;
}

/** Session menu items and the dialogs they open. */
export function useHubCopy(session: Session, menuOpen: boolean): { items: MenuItem[]; dialogs: React.ReactNode } {
  const [open, setOpen] = useState<'to' | 'back' | null>(null);
  const preview = usePreview(session, menuOpen || open === 'to');
  const rec = hubRecord(session);
  if (session.kind === 'chat') return { items: [], dialogs: null };
  const later = (fn: () => void) => () => setTimeout(fn, 0);
  const items: MenuItem[] = [
    { label: 'Move to hub (copy folder)', detail: preview ? preview.line : 'Measuring the folder', onSelect: later(() => setOpen('to')) },
    ...(rec && session.device === 'local' ? [{ label: `Move back to ${rec.deviceName}`, detail: 'Shows the changes first', onSelect: later(() => setOpen('back')) }] : []),
  ];
  const dialogs = (
    <>
      <ToHubDialog session={session} preview={preview} open={open === 'to'} onClose={() => setOpen(null)} />
      {rec && open === 'back' && <BackDialog session={session} rec={rec} onClose={() => setOpen(null)} />}
    </>
  );
  return { items, dialogs };
}

function ProgressLine({ p }: { p: Progress }) {
  const words: Record<Progress['phase'], string> = { measuring: 'Measuring', copying: 'Copying', manifest: 'Recording what was copied', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
  const of = p.totalBytes ? ` of about ${size(p.totalBytes)}` : '';
  return (
    <p className="text-[13px] text-fg-2" aria-live="polite">
      {words[p.phase]}
      {p.phase === 'copying' && `: ${size(p.bytes)}${of}${p.files ? `, ${p.files.toLocaleString('en-US')} files` : ''}`}
      {p.line && (p.phase === 'failed' || p.phase === 'done') && `. ${p.line}`}
    </p>
  );
}

function ToHubDialog({ session, preview, open, onClose }: { session: Session; preview?: HubCopyPreview; open: boolean; onClose: () => void }) {
  const progress = useProgress(session.id);
  const live = progress?.direction === 'to-hub' && !['done', 'failed', 'cancelled'].includes(progress.phase) ? progress : undefined;
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (progress?.phase === 'done' && progress.direction === 'to-hub') {
      previews.delete(session.id);
      setStarted(false);
    }
  }, [progress, session.id]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move to hub"
      footer={
        live || started ? (
          <>
            <Button variant="quiet" onClick={onClose}>
              Hide
            </Button>
            <Button variant="quiet" onClick={() => void attempt(() => api().cancelHubCopy(session.id)).then(() => setStarted(false))}>
              Cancel copy
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="solid"
              disabled={!preview?.fits}
              onClick={async () => {
                if (await attempt(() => api().moveToHub(session.id))) setStarted(true);
              }}
            >
              Copy and move
            </Button>
          </>
        )
      }
    >
      <div className="space-y-2 text-[13px] text-fg-2">
        {preview ? (
          <>
            <p>
              Copies <span className="mono text-fg">{preview.path}</span> from {preview.deviceName}, everything in it (node_modules, build output, .env, .git), to{' '}
              <span className="mono text-fg">{preview.target}</span>, then this session runs there. The folder on {preview.deviceName} stays as it is.
            </p>
            <p className={preview.fits ? 'text-fg' : 'text-fault'}>{preview.line}</p>
          </>
        ) : (
          <p>Measuring the folder</p>
        )}
        {progress && progress.direction === 'to-hub' && (live || started || progress.phase !== 'measuring') && <ProgressLine p={progress} />}
      </div>
    </Dialog>
  );
}

function BackDialog({ session, rec, onClose }: { session: Session; rec: HubCopyRecord; onClose: () => void }) {
  const [diff, setDiff] = useState<HubBackPreview>();
  const [err, setErr] = useState<string>();
  const [del, setDel] = useState(false);
  const progress = useProgress(session.id);
  useEffect(() => {
    api()
      .hubBackPreview(session.id)
      .then(setDiff, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [session.id]);
  const go = async (skipConflicts: boolean) => {
    if (await attempt(() => api().moveBack(session.id, { skipConflicts, deleteRemoved: del }))) onClose();
  };
  const deleted = diff?.files.filter((f) => f.change === 'deleted').length ?? 0;
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title={`Move back to ${rec.deviceName}`}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          {!!diff?.conflicts && (
            <Button variant="quiet" disabled={!diff.online} onClick={() => void go(true)}>
              Copy back without conflicts
            </Button>
          )}
          <Button variant="solid" disabled={!diff?.online} onClick={() => void go(false)}>
            Copy back all
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-fg-2">
        <p>
          Copies what changed in <span className="mono text-fg">{rec.hubPath}</span> since {new Date(rec.copiedAt).toLocaleString()} to <span className="mono text-fg">{diff?.devicePath ?? rec.root}</span> on {rec.deviceName}, then this session runs there.
        </p>
        {err && <p className="text-fault">{err}</p>}
        {!diff && !err && <p>Comparing the hub copy with {rec.deviceName}</p>}
        {diff && (
          <>
            <p className="text-fg">{diff.line}</p>
            {!!diff.conflicts && <p className="text-warn">Conflict: the file changed on {rec.deviceName} too. Copy back all overwrites it there.</p>}
            {!!diff.deviceOnly && <p>{diff.deviceOnly} other files changed on {rec.deviceName} only. They stay as they are.</p>}
            <div className="max-h-[50vh] space-y-1 overflow-auto">
              {diff.files.map((f) => (
                <details key={f.path} className="rounded-[3px] border border-rule px-2 py-1">
                  <summary className="cursor-default">
                    <span className="mono text-fg">{f.path}</span> <span className="text-fg-3">{f.change}</span>
                    {f.conflict && <span className="text-warn"> conflict</span>}
                    {(f.binary || !f.diff) && (f.before !== undefined || f.after !== undefined) && (
                      <span className="text-fg-3">
                        {' '}
                        {f.before !== undefined ? size(f.before) : 'none'} to {f.after !== undefined ? size(f.after) : 'none'}
                      </span>
                    )}
                  </summary>
                  {f.diff && <pre className="mono overflow-auto text-[12px] whitespace-pre text-fg">{f.diff}</pre>}
                </details>
              ))}
              {diff.truncated && <p className="text-fg-3">More files changed than are listed. All of them are copied.</p>}
            </div>
            {deleted > 0 && <Checkbox checked={del} onChange={setDel} label={`Also delete files removed on the hub (${deleted})`} description={`Off: nothing on ${rec.deviceName} is deleted.`} />}
          </>
        )}
        {progress?.direction === 'back' && <ProgressLine p={progress} />}
      </div>
    </Dialog>
  );
}
