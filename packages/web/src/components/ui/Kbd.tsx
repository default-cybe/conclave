import type { ReactNode } from 'react';
import { cn } from '@/lib/text';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/**
 * A keyboard key (spec 4.3, 10.4): mono 11px in fg-3 on bg-raise with a rule
 * border. Inside a button pass `plain`: currentColor at 55% with no fill.
 */
export function Kbd({ children, className, plain }: { children: ReactNode; className?: string; plain?: boolean }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[3px] border px-[5px] font-mono text-[11px] leading-none font-medium',
        plain ? 'border-current bg-transparent text-current opacity-55' : 'border-rule bg-raise text-fg-3',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A key sequence or chord: <Keys keys={[MOD, 'K']} /> or <Keys keys={['G', 'H']} then />. */
export function Keys({ keys, then, className, plain }: { keys: string[]; then?: boolean; className?: string; plain?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        <span key={`${k}${i}`} className="inline-flex items-center gap-1">
          {then && i > 0 && <span className="text-[11px] text-fg-3">then</span>}
          <Kbd plain={plain}>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}
