/**
 * "Share project" where a project of this hub shows: the header of a
 * project's group in the session lists (Group by Project, desktop and
 * phone) and a project's row in Devices, Folders. The dialog loads the first
 * time it opens, so the lists stay light. A project shared already says so
 * and opens it.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { cn } from '@/lib/text';
import { sharedFrom } from '@/lib/sharedProjects';
import { useHub } from '@/store/store';
import type { ShareProjectFrom } from './ShareProjectDialog';

const Dialog = lazy(() => import('./ShareProjectDialog').then((m) => ({ default: m.ShareProjectDialog })));

/** The dialog, loaded the first time it opens. */
export function LazyShareProjectDialog({ open, onClose, from }: { open: boolean; onClose: () => void; from?: ShareProjectFrom }) {
  const [wanted, setWanted] = useState(open);
  useEffect(() => {
    if (open) setWanted(true);
  }, [open]);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <Dialog open={open} onClose={onClose} from={from} />
    </Suspense>
  );
}

/** A quiet "Share" (or "Shared") after a project's name. `phone`: a 44px target. */
export function ShareProjectButton({ projectId, name, phone, className }: { projectId: string; name: string; phone?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const shared = useHub((s) => sharedFrom(projectId, Object.values(s.sharedProjects ?? {})));
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={shared ? `${name} is shared with friends` : `Share ${name} with friends`}
        className={cn('tap shrink-0 font-[450] text-fg-3 transition-colors duration-[var(--dur-1)] hover:text-fg', phone ? '-my-3 px-2 py-3 text-[13px]' : 'text-[12px]', className)}
      >
        {shared ? 'Shared' : 'Share'}
      </button>
      <LazyShareProjectDialog open={open} onClose={() => setOpen(false)} from={{ localProjectId: projectId, name }} />
    </>
  );
}
