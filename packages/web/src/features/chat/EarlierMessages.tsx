import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { loadOlder, useHub } from '@/store/store';

/** A transcript loads its newest page; this reads the page before it when the hub holds more. */
export function EarlierMessages({ sessionId }: { sessionId: string }) {
  const older = useHub((s) => !!s.messagesOlder[sessionId]);
  const [busy, setBusy] = useState(false);
  if (!older) return null;
  return (
    <div className="flex justify-center">
      <Button
        variant="quiet"
        size="sm"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void loadOlder(sessionId).finally(() => setBusy(false));
        }}
      >
        {busy ? 'Loading earlier messages' : 'Show earlier messages'}
      </Button>
    </div>
  );
}
