/**
 * The sidebar's list in Canvas mode (design/canvas-mode SPEC.md 4): the
 * files the canvas opens, not sessions. Programs (flows/<name>.flow.ts) by
 * project folder and device, then workflows: yours, then the library's.
 * Rows look like the session rows (SPEC 5.3): the name, the device in
 * --fg-4, a quiet dot while a run goes on.
 */
import { Link, useLocation } from 'wouter';
import { cn } from '@/lib/text';
import { FILES, fileHref, type CanvasFile } from './fixture';

const ROW = 'relative flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2.5 text-left transition-colors duration-[var(--dur-1)] focus-visible:-outline-offset-2';

/** Group order: each program project, then Yours, then Library. */
function groups(files: CanvasFile[]): Array<{ label: string; files: CanvasFile[] }> {
  const out: Array<{ label: string; files: CanvasFile[] }> = [];
  for (const f of files) {
    const label = f.kind === 'program' ? f.where : f.where === 'Library' ? 'Library workflows' : 'Your workflows';
    const g = out.find((x) => x.label === label) ?? out[out.push({ label, files: [] }) - 1];
    g.files.push(f);
  }
  return out;
}

export function CanvasFiles({ phone, onPick }: { phone?: boolean; onPick?: () => void }) {
  const [loc] = useLocation();
  const path = loc.split('?')[0];
  return (
    <section aria-label="Canvas files">
      <div className={cn('flex items-center gap-2 pr-1 pl-2.5', phone ? 'h-11' : 'h-7')}>
        <h2 className={cn('m-0 min-w-0 flex-1 truncate font-medium text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>Programs and workflows</h2>
      </div>
      {groups(FILES).map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="mt-2">
          <div className={cn('flex items-center pl-2.5 font-medium text-fg-3', phone ? 'min-h-10 text-[13px]' : 'h-7 text-[12px]')}>{g.label}</div>
          {g.files.map((f) => {
            const href = fileHref(f);
            const live = f.nodes.some((n) => n.state === 'running');
            return (
              <Link key={href} href={href} onClick={onPick} aria-current={path === href ? 'page' : undefined} className={cn(ROW, phone ? 'min-h-11 text-[15px]' : 'h-8 text-[13.5px]', path === href ? 'bg-side-active text-fg' : 'text-fg-2 hov:bg-side-hover hov:text-fg')}>
                <span className="min-w-0 flex-1 truncate">{f.kind === 'program' ? `${f.name}.flow.ts` : f.name}</span>
                {f.device && f.kind === 'program' && <span className={cn('shrink-0 text-fg-4', phone ? 'text-[13px]' : 'text-[12px]')}>{f.device}</span>}
                {live && (
                  <span className="relative inline-grid size-2 shrink-0 place-items-center" role="img" aria-label="Running">
                    <span className="cv-dot-pulse size-1.5 rounded-full bg-signal" />
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </section>
  );
}
