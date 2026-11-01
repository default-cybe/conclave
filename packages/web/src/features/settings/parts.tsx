/**
 * Pieces every settings section uses (spec 11.10): a key and value row
 * (label and one line of help on the left, the control on the right), a
 * group (a section heading with rows under it), and saving with a toast only
 * when it fails.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/text';
import { shortDate } from '@/lib/format';
import { reloadConfig, toast, updateConfig } from '@/store/store';
import { api } from '@/lib/api';
import { isOwnerNow } from '@/lib/people';
import { SectionHeading, type SectionAction } from '@/components/ui/Section';

/** "just now", "4m ago", "3h ago", "2d ago", then the date ("17 Aug"). */
export function agoWords(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return shortDate(ts);
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** Merge a patch into the hub config. Booleans and selects save at once; this toasts only on failure. */
export async function save(patch: Record<string, unknown>): Promise<boolean> {
  try {
    await updateConfig(patch);
    return true;
  } catch (e) {
    toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    return false;
  }
}

/**
 * Save a fallback list (models.limitFallback or models.refusalFallback). The
 * owner's is the hub's config; a member's is their own (PATCH /api/me), which
 * the hub checks against the models they can call and shows back in /api/config.
 */
export async function saveFallback(key: 'limitFallback' | 'refusalFallback', value: Record<string, unknown>): Promise<boolean> {
  if (isOwnerNow()) return save({ models: { [key]: value } });
  try {
    await api().updateMe(key === 'limitFallback' ? { usageFallback: value } : { refusalFallback: value });
    await reloadConfig();
    return true;
  } catch (e) {
    toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    return false;
  }
}

/**
 * Label (500) and help (meta fg-3) on the left half, the control on the
 * right. `stack` puts a wide control under the label instead.
 */
export function SettingRow({
  label,
  help,
  children,
  stack,
  top,
  htmlFor,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
  stack?: boolean;
  top?: boolean;
  htmlFor?: string;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={cn('grid gap-x-8 gap-y-2.5 py-3.5', !stack && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]', top || stack ? 'items-start' : 'items-center', className)}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="block text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">
          {label}
        </Label>
        {help && <div className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{help}</div>}
      </div>
      {children !== undefined && <div className={cn('min-w-0', !stack && 'md:flex md:justify-end')}>{children}</div>}
    </div>
  );
}

/** A group of rows under a section heading, with an optional help line. */
export function Group({
  title,
  count,
  action,
  right,
  help,
  children,
  id,
  className,
  rows = true,
}: {
  title: ReactNode;
  count?: number | string;
  action?: SectionAction;
  right?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  rows?: boolean;
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className={cn('scroll-mt-6', className)}>
      <SectionHeading id={id ? `${id}-h` : undefined} count={count} action={action} right={right}>
        {title}
      </SectionHeading>
      {help && <p className="mt-2.5 mb-0.5 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{help}</p>}
      <div className={cn(rows && 'rows')}>{children}</div>
    </section>
  );
}

/** A result in words: the word in its state color, then quiet detail. */
export function Outcome({ word, tone, children, className }: { word: ReactNode; tone: 'ok' | 'fault' | 'dim' | 'warn'; children?: ReactNode; className?: string }) {
  return (
    <span className={cn('state-word text-[13px] text-fg-3 phone:text-[14px]', className)}>
      <span className={tone === 'ok' ? 'text-ok' : tone === 'fault' ? 'text-fault' : tone === 'warn' ? 'text-warn' : 'text-fg-3'}>{word}</span>
      {children && <>&nbsp; {children}</>}
    </span>
  );
}
