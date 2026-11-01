/**
 * "Try the next model" under the notice of a refused reply (Refusal fallback,
 * Settings > Models). The hub drops the refused reply and runs the same turn
 * on the next model and account of the owner's list (core
 * session/refusal-fallback.ts). Shown only on the newest refusal notice, when
 * the hub said a next model exists and nothing runs.
 */
import { useRef, useState } from 'react';
import type { Message, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Overlay';
import { ModelList } from '@/components/pickers/ModelPicker';

interface RefusalMeta {
  type?: string;
  canTryNext?: boolean;
}

/** A refusal notice that offers the next model. */
export function offersNextModel(message: Message): boolean {
  const meta = message.meta as RefusalMeta | undefined;
  return message.kind === 'notice' && meta?.type === 'refusal' && meta.canTryNext === true;
}

export function providerFailureNotice(messages: Message[]): Message | undefined {
  for (const message of [...messages].reverse()) {
    if (message.kind !== 'notice') return undefined;
    if (message.meta?.type === 'provider_error') return message;
  }
}

export function TryNextModel({ message, session, className }: { message: Message; session: Session; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const providerError = message.kind === 'notice' && message.meta?.type === 'provider_error' && message.meta?.canRetry === true;
  // only while nothing came after it: no reply, no newer refusal notice
  const newest = useHub((s) => {
    const list = s.messages[message.sessionId] ?? [];
    const i = list.findIndex((m) => m.id === message.id);
    if (providerError) return providerFailureNotice(list)?.id === message.id;
    return i >= 0 && !list.slice(i + 1).some((m) => (m.role === 'assistant' && m.kind === 'normal') || offersNextModel(m) || (m.role === 'user' && m.kind === 'normal' && m.content.some((b) => b.type === 'text')));
  });
  if (providerError) {
    if (session.status !== 'error' || !newest) return null;
    return (
      <div className={className}>
        <Button ref={anchor} variant="outline" size="sm" disabled={busy} aria-expanded={picking} onClick={() => setPicking(true)}>
          {busy ? 'Retrying' : 'Retry with another model'}
        </Button>
        <Popover anchor={anchor} open={picking && !busy} onClose={() => setPicking(false)} width={380} label="Retry with another model" sheetTitle="Retry with another model">
          <ModelList value={session.model} harnesses={false} onDone={() => setPicking(false)} onChange={async (model) => {
            if (locked.current) return;
            locked.current = true;
            setBusy(true);
            setPicking(false);
            const result = await attempt(() => api().retryProvider(session.id, message.id, model));
            if (!result) { locked.current = false; setBusy(false); }
          }} />
        </Popover>
      </div>
    );
  }
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
