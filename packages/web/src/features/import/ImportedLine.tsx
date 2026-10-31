/**
 * The line under an imported session's title: where it came from, and when
 * the source grew, how many new messages are there with Sync. A sync that
 * finds both sides grew makes a fork ("Continued in Claude Code on ...").
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { SessionImportInfo } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { hrefOf } from '@/lib/recents';
import { toast, useHub } from '@/store/store';
import { TextAction } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { useDeviceNames } from './PastChats';
import { importedLine } from './words';
import { inImported } from '@conclave/core/session/imported';

export function importInfo(s: Session): SessionImportInfo | undefined {
  const i = s.meta?.import as SessionImportInfo | undefined;
  return i && typeof i === 'object' && typeof i.source === 'string' ? i : undefined;
}

/** A copy of a chat the merge archived: every message of it is in another session (ImportService.mergeDuplicates), so lists leave it out. */
export function isDuplicateCopy(s: Session): boolean {
  return !!(s.meta?.import as { duplicateOf?: string } | undefined)?.duplicateOf;
}

/** The other copies of an imported chat with messages of their own (a merge's branches, a sync's forks), for links under its title. */
export function importBranches(sessions: Record<string, Session>, id: string): Session[] {
  return Object.values(sessions).filter((s) => s.parentId === id && s.tags.includes('imported') && !isDuplicateCopy(s));
}

export function ImportedLine({ session, className }: { session: Session; className?: string }) {
  const info = importInfo(session);
  const names = useDeviceNames();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const sessions = useHub((s) => s.sessions);
  const branches = useMemo(() => importBranches(sessions, session.id), [sessions, session.id]);
  if (!info) return null;
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api().syncImported(session.id);
      if (r.state === 'updated') toast({ title: `Added ${r.added} ${r.added === 1 ? 'message' : 'messages'} from ${info.device.startsWith('upload:') ? 'the export' : (names[info.device] ?? info.device)}.`, level: 'success' });
      else if (r.state === 'forked' && r.forkedSessionId) {
        toast({ title: 'Both sides had new messages, so the other side became its own session.', level: 'success', action: { label: 'Open it', run: () => navigate(`/s/${r.forkedSessionId}`) } });
      } else if (r.state === 'failed') toast({ title: r.error ?? 'The sync failed.', level: 'error' });
      else toast({ title: 'Nothing new there.', level: 'info' });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const behind = info.state === 'behind' && (info.newThere ?? 0) > 0;
  const diverged = info.state === 'diverged';
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]', className)}>
      <span className="min-w-0">{importedLine(info, names)}</span>
      {inImported(session) && <span className="text-fg-2">Write below to continue it here.</span>}
      {behind && <span className="text-fg-2">{info.newThere} new {info.newThere === 1 ? 'message' : 'messages'} there.</span>}
      {diverged && <span className="text-warn">Continued there and here.</span>}
      {busy ? <LiveStatus state="tool" label="Syncing" size={14} /> : !info.device.startsWith('upload:') && <TextAction label={diverged ? 'Copy the other side' : 'Sync'} onClick={() => void sync()} />}
      {branches.map((b) => (
        <Link key={b.id} href={hrefOf(b)} className="link min-w-0 truncate">
          {b.title}
        </Link>
      ))}
    </div>
  );
}
