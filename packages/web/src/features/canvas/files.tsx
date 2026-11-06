/**
 * The files Canvas opens (docs/design/CANVAS-MODE.md 3): programs
 * (flows/*.flow.ts) in each folder a Code session works in, read through the
 * newest session there (the flow routes are a session's), then workflows:
 * yours, the library's, and recent runs. The sidebar lists them in Canvas
 * mode; the start page lists them too.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '@/lib/api';
import { folderName } from '@/lib/format';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { useLibrary, useRuns } from '../workflows/data';
import { useNewFile } from './NewFile';
import { fileGroups, fileHref, fileTitle, folderSessions, workflowFiles, type CanvasFile } from './model';

export { canvasHome } from './model';

type Program = Extract<CanvasFile, { kind: 'program' }>;

/** Every file, programs first; `loading` while the first answers are out. */
export function useCanvasFiles(): { files: CanvasFile[]; loading: boolean; folderLabel: (f: Program) => string } {
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const folders = useMemo(() => folderSessions(Object.values(sessions)), [sessions]);
  const key = folders.map((s) => s.id).join(',');
  const [programs, setPrograms] = useState<Program[]>();
  useEffect(() => {
    let alive = true;
    // a folder on a device that is offline answers an error: it lists nothing, the rest still do
    void Promise.all(folders.map((s) => api().flows(s.id).then((l) => l.map((f): Program => ({ kind: 'program', name: f.name, device: s.device, cwd: s.cwd, sessionId: s.id })), () => [] as Program[]))).then((all) => alive && setPrograms(all.flat()));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const library = useLibrary();
  const runs = useRuns({ limit: 8 });
  const files = useMemo(() => [...(programs ?? []), ...workflowFiles(library.data, runs.data)], [programs, library.data, runs.data]);
  const folderLabel = (f: Program) => `${folderName(f.cwd) || f.cwd}, ${devices[f.device || 'local']?.name ?? f.device}`;
  return { files, loading: !programs || (!library.data && !library.error), folderLabel };
}

/** A file's state at the right of its row: a dot while it runs, failed in its tone. */
function FileState({ f, phone }: { f: CanvasFile; phone?: boolean }) {
  if (f.kind !== 'workflow') return null;
  if (f.live)
    return (
      <span className="relative inline-grid size-2 shrink-0 place-items-center" role="img" aria-label="Running">
        <span className="cv-dot-pulse size-1.5 rounded-full bg-signal" />
      </span>
    );
  if (f.failed) return <span className={cn('shrink-0 text-fault', phone ? 'text-[13px]' : 'text-[12px]')}>failed</span>;
  return null;
}

const ROW = 'relative flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2.5 text-left transition-colors duration-[var(--dur-1)] focus-visible:-outline-offset-2';

/** The sidebar's list in Canvas mode (and the phone's drawer). */
export function SideFiles({ phone, onPick }: { phone?: boolean; onPick?: () => void }) {
  const { files, loading, folderLabel } = useCanvasFiles();
  const [loc] = useLocation();
  const path = decodeURIComponent(loc.split('?')[0]);
  const groups = fileGroups(files, folderLabel);
  const n = useNewFile();
  return (
    <section aria-label="Programs and workflows">
      {n.dialog}
      <div className={cn('flex items-center pr-1 pl-2.5', phone ? 'h-11' : 'h-7')}>
        <h2 className={cn('m-0 min-w-0 flex-1 truncate font-medium text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>Programs and workflows</h2>
        <button type="button" onClick={() => (onPick?.(), void n.program())} title="A blank program, opened on an empty canvas" className={cn('shrink-0 rounded-[6px] px-2 font-medium text-fg-2 hov:bg-side-hover hov:text-fg', phone ? 'min-h-11 text-[15px]' : 'h-6 text-[12px]')}>
          New
        </button>
      </div>
      {!loading && groups.length === 0 && <p className={cn('m-0 px-2.5 py-2 leading-[1.45] text-fg-3', phone ? 'text-[14px]' : 'text-[12.5px]')}>Programs (flows/*.flow.ts in a Code session's folder) and workflows show up here.</p>}
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="mt-2">
          <div className={cn('flex items-center pl-2.5 font-medium text-fg-3', phone ? 'min-h-10 text-[13px]' : 'h-7 text-[12px]')}>
            <span className="min-w-0 truncate">{g.label}</span>
          </div>
          {g.files.map((f) => {
            const href = fileHref(f);
            const on = path === decodeURIComponent(href.split('?')[0]) && (f.kind !== 'program' || loc.includes(new URLSearchParams({ cwd: f.cwd }).toString()));
            return (
              <Link key={href} href={href} onClick={onPick} aria-current={on ? 'page' : undefined} className={cn(ROW, phone ? 'min-h-11 text-[15px]' : 'h-8 text-[13.5px]', on ? 'bg-side-active text-fg' : 'text-fg-2 hov:bg-side-hover hov:text-fg')}>
                <span className={cn('min-w-0 flex-1 truncate', f.kind === 'program' && 'mono text-[12.5px]')}>{fileTitle(f)}</span>
                <FileState f={f} phone={phone} />
              </Link>
            );
          })}
        </div>
      ))}
      <Link href="/canvas" onClick={onPick} className={cn('mt-2 flex items-center rounded-[8px] px-2.5 text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-side-hover hov:text-fg', phone ? 'min-h-11 text-[15px]' : 'h-8 text-[13px]', path === '/canvas' && 'bg-side-active text-fg')}>
        All of Canvas
      </Link>
    </section>
  );
}
