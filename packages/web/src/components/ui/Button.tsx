import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import { Kbd } from './Kbd';
import { Tooltip } from './Tooltip';

/**
 * Buttons (spec 10.4).
 * - solid: the one primary action per region (Allow once, Start, Continue, Save)
 * - outline: secondary actions, answer options
 * - quiet: tertiary (Deny, Skip for now, Open session)
 * - quiet-fault: quiet that turns fault on hover (Deny on the approval card)
 * - danger: quiet with fault text; danger-outline for the confirm button of a destructive dialog
 * Legacy names map: primary -> solid, secondary -> outline, ghost -> quiet.
 */
export type ButtonVariant = 'solid' | 'outline' | 'quiet' | 'quiet-fault' | 'danger' | 'danger-outline' | 'primary' | 'secondary' | 'ghost';
/** sm 26px, md 30px, lg 38px, touch 44px (phones). xs is a legacy alias of sm. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'touch' | 'xs';

const VARIANT: Record<ButtonVariant, string> = {
  solid: 'border border-solid bg-solid text-solid-fg hov:brightness-[0.94] press:brightness-[0.88] aria-disabled:border-rule aria-disabled:bg-hover aria-disabled:text-fg-3',
  outline: 'border border-rule-2 bg-transparent text-fg hov:bg-hover press:bg-rule aria-disabled:text-fg-3',
  quiet: 'border border-transparent bg-transparent text-fg-2 hov:bg-hover hov:text-fg press:bg-rule aria-disabled:text-fg-3',
  'quiet-fault': 'border border-transparent bg-transparent text-fg-2 hov:bg-[color-mix(in_oklab,var(--fault)_10%,transparent)] hov:text-fault aria-disabled:text-fg-3',
  danger: 'border border-transparent bg-transparent text-fault hov:bg-[color-mix(in_oklab,var(--fault)_10%,transparent)] aria-disabled:text-fg-3',
  'danger-outline': 'border border-fault bg-transparent text-fault hov:bg-[color-mix(in_oklab,var(--fault)_10%,transparent)] aria-disabled:border-rule aria-disabled:text-fg-3',
  primary: '',
  secondary: '',
  ghost: '',
};
VARIANT.primary = VARIANT.solid;
VARIANT.secondary = VARIANT.outline;
VARIANT.ghost = VARIANT.quiet;

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-[26px] px-3 text-[12.5px] gap-1.5 [&_svg]:size-3.5',
  sm: 'h-[26px] px-3 text-[12.5px] gap-1.5 [&_svg]:size-3.5',
  md: 'h-[30px] px-3 text-[13px] gap-2 [&_svg]:size-4',
  lg: 'h-[38px] px-[18px] text-[14px] gap-2 [&_svg]:size-4',
  touch: 'h-11 px-4 text-[15px] gap-2 [&_svg]:size-4',
};

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[var(--r-1)] font-medium leading-none transition-[color,background-color,border-color,filter] duration-[var(--dur-1)] ease-[var(--ease)] aria-disabled:cursor-default';

/**
 * Phones: a button under 44px gets a 44px place to tap that does not move
 * the layout (docs/design/MOBILE-V2.md, the iPhone details).
 */
export const PHONE_HIT = 'phone:relative phone:after:absolute phone:after:top-1/2 phone:after:left-1/2 phone:after:h-11 phone:after:w-full phone:after:min-w-11 phone:after:-translate-x-1/2 phone:after:-translate-y-1/2';

export function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', extra?: string) {
  const quietPad = (variant === 'quiet' || variant === 'ghost' || variant === 'danger' || variant === 'quiet-fault') && (size === 'md' || size === 'sm' || size === 'xs') ? 'px-2' : '';
  return cn(BASE, VARIANT[variant], SIZE[size], quietPad, size !== 'touch' && PHONE_HIT, extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Only for the Stop square or a logo; buttons with a label otherwise carry no icon (spec 8.1). */
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** A key hint inside the button: "↵", "esc". */
  kbd?: string;
  /**
   * Working state: no spinner. Pass the progressive verb ("Testing") and the
   * label swaps to it while the button keeps its width. `true` keeps the label.
   */
  busy?: boolean | string;
  /** Stretch to the container width. */
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', icon, iconRight, kbd, busy, full, className, children, disabled, onClick, type = 'button', ...rest },
  ref,
) {
  const working = busy;
  const inert = disabled || !!working;
  const busyText = typeof busy === 'string' ? busy : undefined;
  return (
    <button
      ref={ref}
      type={type}
      aria-disabled={inert || undefined}
      aria-busy={working ? true : undefined}
      onClick={inert ? (e) => e.preventDefault() : onClick}
      className={buttonClass(variant, size, cn(full && 'w-full', className))}
      {...rest}
    >
      {icon}
      {busyText ? (
        <span className="grid">
          <span className={cn('col-start-1 row-start-1', busyText && working && 'invisible')}>{children}</span>
          <span className={cn('col-start-1 row-start-1', !working && 'invisible')} aria-hidden={!working}>
            {busyText}
          </span>
        </span>
      ) : (
        children
      )}
      {kbd && <Kbd plain>{kbd}</Kbd>}
      {iconRight}
    </button>
  );
});

/** A link styled as a button (wouter Link for app paths). */
export function ButtonLink({ href, variant = 'outline', size = 'md', className, children, external, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; variant?: ButtonVariant; size?: ButtonSize; external?: boolean }) {
  const cls = buttonClass(variant, size, className);
  if (external || /^[a-z]+:/.test(href))
    return (
      <a href={href} className={cls} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon only buttons always carry a label (spec 14). */
  label: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'touch';
  variant?: 'quiet' | 'outline' | 'solid';
  active?: boolean;
  /** Show the label as a tooltip on hover and focus. Default true. */
  tooltip?: boolean;
}

const ICON_SIZE = {
  xs: 'size-[26px] [&_svg]:size-3.5',
  sm: 'size-[26px] [&_svg]:size-3.5',
  md: 'size-[30px] [&_svg]:size-4',
  lg: 'size-[38px] [&_svg]:size-4',
  touch: 'size-11 [&_svg]:size-[18px]',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'quiet', active, tooltip = true, className, children, disabled, onClick, type = 'button', ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-pressed={active === undefined ? undefined : active}
      onClick={disabled ? (e) => e.preventDefault() : onClick}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--r-1)] transition-[color,background-color,border-color] duration-[var(--dur-1)] aria-disabled:cursor-default aria-disabled:text-fg-4 [&_svg]:stroke-[1.75]',
        ICON_SIZE[size],
        size !== 'touch' && PHONE_HIT,
        variant === 'quiet' && 'text-fg-3 hov:bg-hover hov:text-fg',
        variant === 'outline' && 'border border-rule-2 text-fg-2 hov:bg-hover hov:text-fg',
        variant === 'solid' && 'border border-solid bg-solid text-solid-fg hov:brightness-[0.94]',
        active && variant === 'quiet' && 'bg-hover text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});
