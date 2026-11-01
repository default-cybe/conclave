/** Pieces the Memory tabs share: a side panel, test steps, a working line. */
import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { MemoryConnectionTestResult } from '@conclave/core/client';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog, SideSheet } from '@/components/ui/Overlay';
import { Command } from '@/components/ui/Code';
import { LiveStatus } from '@/components/motion';
import { msWords, sentence } from './words';

/** Error text from anything thrown, as a sentence. */
export function errMsg(e: unknown): string {
  return sentence(e instanceof Error ? e.message : String(e));
}

/**
 * A form or detail panel from the right (a side sheet with a header, a body
 * that scrolls and a footer). Full screen on phones. Only native controls
 * inside: menus and pickers open under side sheets.
 */
export function Panel({
  open,
  onClose,
  title,
  sub,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const mobile = useIsMobile();
  return (
    <SideSheet open={open} onClose={onClose} width={mobile ? 4096 : width} label={title} className={cn(mobile && 'border-l-0')}>
      <header className="flex shrink-0 items-start gap-3 border-b border-rule px-5 pt-4 pb-3.5 phone:px-4 phone:pt-2 phone:pb-3">
        <div className="min-w-0 flex-1 phone:pt-2.5">
          <h2 className="t-title truncate text-fg">{title}</h2>
          {sub && <div className="mt-0.5 min-w-0 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{sub}</div>}
        </div>
        <IconButton label="Close" size={mobile ? 'touch' : 'sm'} onClick={onClose} data-close tooltip={false} className={cn(!mobile && '-mr-1.5')}>
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-8 phone:px-4">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 phone:px-4">{footer}</footer>}
    </SideSheet>
  );
}

/** A working line: the live strip, a verb, elapsed time and what is happening. */
export function Working({ word, since, detail, className }: { word: string; since: number; detail?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1 text-[13px] phone:text-[14px]', className)}>
      <LiveStatus state="tool" label={word} startedAt={since} />
      {detail && <span className="text-fg-3">{detail}</span>}
    </div>
  );
}

/**
 * Test steps with their timings, then the error and the hint in plain words
 * (UI-HANDOFF.md: "renders steps with their timings, then hint").
 */
export function TestSteps({ result, className }: { result: MemoryConnectionTestResult; className?: string }) {
  return (
    <div className={cn('text-[13px] phone:text-[14px]', className)}>
      <p className="mb-1.5">
        {result.ok ? <span className="text-ok">Works</span> : <span className="text-fault">Failed</span>}
        <span className="text-fg-3">
          {' '}
          in {msWords(result.latencyMs)}
          {result.ok && result.hits !== undefined ? `, the test search found ${result.hits === 1 ? '1 note' : `${result.hits} notes`}` : ''}
        </span>
      </p>
      <ol className="list-none p-0">
        {result.steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[96px_52px_minmax(0,1fr)] items-baseline gap-x-3 border-t border-rule py-1.5 phone:grid-cols-[88px_52px_minmax(0,1fr)]">
            <span className="text-fg-2">{s.step}</span>
            <span className={cn('num text-right', s.ok ? 'text-fg-3' : 'text-fault')}>{s.ms !== undefined ? msWords(s.ms) : s.ok ? '' : 'failed'}</span>
            <span className={cn('min-w-0 break-words', s.ok ? 'text-fg-3' : 'text-fault')}>{s.detail ?? (s.ok ? 'ok' : 'failed')}</span>
          </li>
        ))}
      </ol>
      {!result.ok && (result.error || result.hint) && (
        <div className="mt-0 border-t border-rule pt-2">
          <p className="max-w-[64ch] text-fg-2">
            {result.error && <span className="text-fault">{sentence(result.error)}</span>} {result.hint}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A command with a copy button. Long tokens (a JSON argument, a URL) wrap
 * inside the box instead of pushing the page sideways; short ones stay whole.
 */
export function Cmd({ command, className }: { command: string; className?: string }) {
  return <Command command={command} copy className={cn('[&_span]:whitespace-pre-wrap [&_span]:[overflow-wrap:anywhere]', className)} />;
}

/**
 * Confirm a destructive action (spec 10.12): names the thing, Cancel and the
 * verb. Built on Dialog so the buttons are 44px tall on phones.
 */
export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirm,
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: string;
  body?: ReactNode;
  confirm: string;
  busy: string;
  children?: ReactNode;
}) {
  const mobile = useIsMobile();
  const [working, setWorking] = useState(false);
  const size = mobile ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger-outline"
            size={size}
            busy={working ? busy : false}
            onClick={async () => {
              setWorking(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setWorking(false);
              }
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {body && <p>{body}</p>}
      {children}
    </Dialog>
  );
}
