/**
 * The hub's fingerprint in groups of four (docs/design/HUB-LOGIN-AND-IDENTITY.md),
 * the way people read it aloud and compare it: after a password login, and in
 * Settings, Remote access on the hub.
 */
import { fingerprintGroups } from '@/lib/identity';
import { cn } from '@/lib/text';

export function Fingerprint({ value, size = 'lg', className }: { value: string; size?: 'lg' | 'sm'; className?: string }) {
  const groups = fingerprintGroups(value);
  return (
    <p
      aria-label={`Fingerprint ${groups.join(' ')}`}
      className={cn(
        'm-0 grid w-max grid-cols-4 font-mono text-fg [font-feature-settings:"zero"_1]',
        size === 'lg' ? 'gap-x-4 gap-y-1.5 text-[19px] leading-[1.35] phone:text-[20px]' : 'gap-x-2.5 gap-y-0.5 text-[13px] leading-[1.5] phone:text-[14px]',
        className,
      )}
    >
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </p>
  );
}
