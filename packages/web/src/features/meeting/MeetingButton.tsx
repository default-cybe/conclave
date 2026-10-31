/**
 * "Meeting" in a Code session's header (docs/design/MEETING-MODE.md 1.1):
 * makes a meeting in the session's folder and opens the overlay on it.
 * Shown only in the desktop app or while a desktop app of this account is
 * online. Without the desktop app here, it opens the meeting page, which
 * says to listen from the desktop app.
 */
import { useLocation } from 'wouter';
import { useState } from 'react';
import type { Session } from '@conclave/core/types';
import { Button } from '@/components/ui/Button';
import { isDesktopApp } from '@/lib/notify';
import { toast, useHub } from '@/store/store';
import { meetings, openOverlay } from './api';

export function MeetingButton({ session }: { session: Session }) {
  const desktopOnline = useHub((s) => Object.values(s.apps).some((a) => a.platform === 'desktop' && a.online));
  const [busy, setBusy] = useState(false);
  const [, go] = useLocation();
  if (!isDesktopApp() && !desktopOnline) return null;
  const start = async () => {
    setBusy(true);
    try {
      const m = await meetings().create({ sessionId: session.id });
      if (!(await openOverlay(m.id))) go(`/meetings/${m.id}`);
    } catch (e) {
      toast({ title: 'Could not start the meeting', body: e instanceof Error ? e.message : String(e), level: 'error' });
    }
    setBusy(false);
  };
  return (
    <Button variant="quiet" size="sm" disabled={busy} onClick={() => void start()} className="shrink-0">
      {busy ? 'Preparing' : 'Meeting'}
    </Button>
  );
}
