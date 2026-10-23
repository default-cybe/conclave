/**
 * "Try the next model" under the notice of a refused reply (Refusal fallback,
 * Settings > Models). The hub drops the refused reply and runs the same turn
 * on the next model and account of the owner's list (core
 * session/refusal-fallback.ts). Shown only on the newest refusal notice, when
 * the hub said a next model exists and nothing runs.
 */
import { useState } from 'react';
import type { Message, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';

interface RefusalMeta {
  type?: string;
  canTryNext?: boolean;
}

/** A refusal notice that offers the next model. */
export function offersNextModel(message: Message): boolean {
  const meta = message.meta as RefusalMeta | undefined;
  return message.kind === 'notice' && meta?.type === 'refusal' && meta.canTryNext === true;
}

export function TryNextModel({ message, session, className }: { message: Message; session: Session; className?: string }) {
  const [busy, setBusy] = useState(false);
  // only while nothing came after it: no reply, no newer refusal notice
  const newest = useHub((s) => {
    const list = s.messages[message.sessionId] ?? [];
    const i = list.findIndex((m) => m.id === message.id);
    return i >= 0 && !list.slice(i + 1).some((m) => (m.role === 'assistant' && m.kind === 'normal') || offersNextModel(m) || (m.role === 'user' && m.kind === 'normal' && m.content.some((b) => b.type === 'text')));
  });
  if (!offersNextModel(message) || !newest || session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input') return null;
  return (
    <div className={className}>
      <Button
        variant="outline"
        size="sm"
        busy={busy ? 'Trying' : false}
        onClick={async () => {
          setBusy(true);
          await attempt(() => api().tryNextModel(session.id));
          setBusy(false);
        }}
      >
        Try the next model
      </Button>
    </div>
  );
}
