import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { useUi } from '@/store/ui';

/**
 * A scrolling page inside the shell. Gutters: 32px desktop, 24 tablet, 16
 * phone. width="wide" caps at 1440 (Home), "column" is the 720px column for
 * Settings, editors and onboarding steps, "full" uses the whole width.
 */
export function Page({ children, width = 'wide', className, innerClassName, scroll = true, id }: { children: ReactNode; width?: 'wide' | 'column' | 'full'; className?: string; innerClassName?: string; scroll?: boolean; id?: string }) {
  return (
    <div id={id} className={cn('min-h-0 flex-1', scroll && 'overflow-y-auto overscroll-contain', className)}>
      <div
        className={cn(
          'mx-auto w-full px-[var(--gutter)] pb-16 phone:pb-8',
          width === 'wide' && 'max-w-[calc(1440px+2*var(--gutter))]',
          width === 'column' && 'max-w-[calc(720px+2*var(--gutter))]',
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Every page except Home starts with this (spec 11): page-title on the left,
 * page actions on the right (at most one solid), 24px above, 20px below. A
 * subtitle only when it carries state ("214 notes, 6 this week").
 */
export function PageHeader({ title, sub, actions, children, className }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn('pt-6 pb-5 phone:pt-2', className)}>
      {/* The title row is as tall as a button, so titles sit at the same height on every page, with or without actions.
          Phones show the title in the bar (docs/design/MOBILE-V2.md 7): the row keeps the actions, at the right. */}
      <div className={cn('flex min-h-[30px] items-center gap-4', actions ? 'phone:min-h-11' : 'phone:min-h-0')}>
        <h1 className="t-page min-w-0 flex-1 text-fg phone:sr-only">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2 phone:ml-auto">{actions}</div>}
      </div>
      {sub && <p className="mt-1 text-[13px] text-fg-3 phone:text-[14px]">{sub}</p>}
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

/**
 * Tell the shell what this page is called. On phones the header shows the
 * title with a back chevron to `back` (inner pages), and `action` (a text
 * button such as "Details") at the right instead of the hub state. The
 * shell makes the document title from it ("Remote access, Conclave").
 * Top-level pages that only want the brand header do not need this.
 */
export function usePageHeader(title: string | undefined, back?: string, action?: ReactNode) {
  useEffect(() => {
    if (!title) return;
    useUi.setState({ header: { title, back, action } });
    return () => {
      if (useUi.getState().header?.title === title) useUi.setState({ header: undefined });
    };
  }, [title, back, action]);
}
