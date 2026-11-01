/**
 * The Welcome layout (spec 11.11 Welcome, 11.12 Connect): a 56px top bar,
 * the hero wave band full width, then the wordmark and the content side by
 * side on a rule. The hero takes the height that is left, between 240 and
 * 560px (38vh on phones), so the page fills one screen without scrolling.
 */
import type { ReactNode } from 'react';
import { Brand } from '@/components/brand/Mark';
import { Wave } from '@/components/wave';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';

export function IntroFrame({
  label = 'Setup',
  topRight,
  wordmark = 92,
  align = 'end',
  children,
  bottom,
  hero,
  className,
}: {
  /** Quiet word after the brand ("Setup", "Connect"). */
  label?: string;
  topRight?: ReactNode;
  /** Wordmark size on desktop: 92 on Welcome, 64 on Connect. Phones use 64. */
  wordmark?: 92 | 64;
  /** end: wordmark and content share the bottom line (Welcome). start: both hang from the rule (Connect). */
  align?: 'start' | 'end';
  children: ReactNode;
  /** Under the intro row (the procedure strip). */
  bottom?: ReactNode;
  /** In place of the hero wave (the sign-in's ASCII conclave). Fills the band absolutely. */
  hero?: ReactNode;
  className?: string;
}) {
  const mobile = useIsMobile();
  return (
    <div className={cn('h-full overflow-y-auto bg-bg pt-safe pb-safe', className)}>
      <div className="flex min-h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 px-10 phone:h-[52px] phone:px-4 md:max-lg:px-6">
          <Brand size={15} />
          <span className="text-[13px] text-fg-3 phone:hidden">{label}</span>
          <div className="ml-auto flex items-center gap-5 text-[13px] text-fg-3 phone:gap-4 phone:text-[14px]">{topRight}</div>
        </header>

        {/* the hero soaks up the free height first (grow 1000), the intro row gets what is left past 560px */}
        <div className={cn('relative', mobile ? 'h-[38vh] flex-none' : 'max-h-[560px] min-h-[240px] flex-[1000_1_0px]')}>
          {hero ?? <Wave variant="hero" gap={8} radius={1.4} className="absolute inset-0 h-full" />}
        </div>

        <div
          className={cn(
            'grid flex-[1_0_auto] gap-x-16 gap-y-7 border-t border-rule px-10 pt-9 pb-10 lg:grid-cols-2 xl:grid-cols-[minmax(0,8fr)_minmax(0,5fr)] phone:px-4 phone:pt-7 phone:pb-8 md:max-lg:px-6',
            align === 'end' ? 'items-end' : 'content-start items-start',
          )}
        >
          <h1 className="t-wordmark m-0 text-fg" style={wordmark === 64 && !mobile ? { fontSize: 64 } : undefined}>
            Conclave
          </h1>
          <div className="min-w-0 lg:max-w-[520px]">{children}</div>
        </div>

        {bottom && <div className="shrink-0">{bottom}</div>}
      </div>
    </div>
  );
}
