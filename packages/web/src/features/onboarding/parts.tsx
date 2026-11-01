/** Small pieces the setup steps share. */
import type { ReactNode } from 'react';
import type { ButtonSize } from '@/components/ui/Button';
import { LiveStatus } from '@/components/motion';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';

/** Button size for controls inside a step: the given size on desktop, 44px on phones (spec 12.1, 14). */
export function useCtlSize(desktop: ButtonSize = 'md'): ButtonSize {
  return useIsMobile() ? 'touch' : desktop;
}

/** On phones a text link gets a 44px tall hit area without moving the text around it. */
export const TAP = 'phone:-my-3 phone:inline-block phone:py-3';

/** An inline text action inside step content reads as a link: underlined, like Skip setup and Finish later. */
export const LINK = `underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg-3 ${TAP}`;

/**
 * A setting as a row (spec 11.10): label (500) and one line of help on the
 * left, the control on the right. Rows stack on phones.
 */
export function SettingRow({ label, help, children, className, htmlFor, top }: { label: ReactNode; help?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; top?: boolean }) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={cn('grid gap-x-8 gap-y-2.5 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]', top ? 'items-start' : 'items-center', className)}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="block text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">
          {label}
        </Label>
        {help && <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export type Outcome = { state: 'idle' } | { state: 'working'; word: string; detail?: ReactNode; startedAt?: number } | { state: 'ok'; word: string; detail?: ReactNode } | { state: 'fail'; word: string; detail?: ReactNode };

/** A result in words: "Works  7 models, 212 ms", "Failed  401", or a live strip while working. */
export function OutcomeWords({ outcome, className }: { outcome: Outcome; className?: string }) {
  if (outcome.state === 'idle') return null;
  if (outcome.state === 'working') return <LiveStatus state="tool" label={outcome.word} detail={outcome.detail} startedAt={outcome.startedAt} className={className} />;
  return (
    <span className={cn('state-word text-[13px] text-fg-3 phone:text-[14px]', className)}>
      <span className={outcome.state === 'ok' ? 'text-ok' : 'text-fault'}>{outcome.word}</span>
      {outcome.detail && <>&nbsp; {outcome.detail}</>}
    </span>
  );
}

/** A note block for the bottom of a step: a short heading and one or two sentences. */
export function Footnote({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="m-0 text-[13px] font-[560] text-fg phone:text-[14px]">{title}</h3>
      <p className="m-0 mt-1 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{children}</p>
    </div>
  );
}

/** Error text from anything thrown. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "A, B and C" */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
