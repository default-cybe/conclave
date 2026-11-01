/**
 * Small pieces the catalog tabs share: a load error line, the detail sheet
 * (a side sheet on desktop, full screen on phones), anchor scrolling and a
 * few words helpers.
 */
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { IconButton } from '@/components/ui/Button';
import { SideSheet } from '@/components/ui/Overlay';
import { Notice } from '@/components/ui/Section';

/** Buttons and inputs reach 44px on phones. */
export const TOUCH = 'phone:h-11 phone:px-4 phone:text-[15px]';

/** The first sentence of a long tool or skill description. */
export function firstSentence(text: string | undefined, max = 140): string {
  if (!text) return '';
  const one = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(one);
  const s = m ? m[1] : one;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "a, b or c". */
export function orList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** End a hub message with exactly one period: "Needs approval" and "Plan mode is read-only." both read right. */
export function sentence(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** A reload that failed while older data is still on screen: say it is stale and offer a retry. */
export function RefreshFailed({ error, retry, className }: { error: string | undefined; retry: () => void; className?: string }) {
  if (!error) return null;
  return (
    <Notice tone="fault" className={className} action={{ label: 'Try again', onClick: retry }}>
      {`Failed. Could not refresh, so this may be out of date. ${sentence(error)}`}
    </Notice>
  );
}

/** A failed first load: what failed, why, and a retry. */
export function LoadFailed({ what, error, retry, className }: { what: string; error: string; retry: () => void; className?: string }) {
  const why = sentence(error);
  return (
    <Notice tone="fault" className={className} action={{ label: 'Try again', onClick: retry }}>
      {`Failed. Could not load ${what}. ${why} Check that the hub is running, then try again.`}
    </Notice>
  );
}

/**
 * A detail view for one item. Desktop: a side sheet from the right. Phones:
 * full screen. Escape and the close button both close it.
 */
export function DetailSheet({ open, onClose, title, meta, children, label }: { open: boolean; onClose: () => void; title: ReactNode; meta?: ReactNode; children: ReactNode; label: string }) {
  const mobile = useIsMobile();
  const width = mobile ? (typeof window === 'undefined' ? 390 : window.innerWidth) : 640;
  return (
    <SideSheet open={open} onClose={onClose} width={width} label={label} className={cn(mobile && 'border-l-0')}>
      <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-rule bg-bg px-6 pt-5 pb-4 phone:px-4 phone:pt-3">
        <div className="min-w-0 flex-1">
          <h2 tabIndex={-1} data-autofocus className="t-title break-words text-fg outline-none">
            {title}
          </h2>
          {meta && <div className="mt-1 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{meta}</div>}
        </div>
        <IconButton label="Close" size={mobile ? 'touch' : 'sm'} onClick={onClose} className="-mr-1.5 shrink-0" data-close tooltip={false}>
          <X />
        </IconButton>
      </div>
      <div className="px-6 pt-5 pb-10 phone:px-4">{children}</div>
    </SideSheet>
  );
}

/** A labelled block inside a detail sheet: a small heading, then content. */
export function Block({ title, children, className, right }: { title: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={cn('mt-6 first:mt-0', className)}>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="t-section text-fg">{title}</h3>
        {right && <span className="ml-auto text-[12px] text-fg-3">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/** Scroll to #id once `ready` is true (e.g. /extensions/sources#sync). */
export function useHashScroll(id: string, ready: boolean) {
  useEffect(() => {
    if (!ready || typeof location === 'undefined' || location.hash !== `#${id}`) return;
    const el = document.getElementById(id);
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [id, ready]);
}

/** Strip YAML frontmatter from a markdown file and return both parts. */
export function splitFrontmatter(text: string): { fields: Array<[string, string]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
  }
  return { fields, body: text.slice(m[0].length).replace(/^\s+/, '') };
}
