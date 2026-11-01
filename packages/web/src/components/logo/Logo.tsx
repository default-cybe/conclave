/**
 * Logos are identity, not icons (spec 8). Mono by default, taking the color
 * of the text next to them. Pass tone="brand" only where the model or
 * provider is the subject of the row (spec 8.3); the Appearance setting
 * "One color" forces mono everywhere.
 */
import { useId, useMemo, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { harnessLabel, modelName, providerName, splitRef } from '@/lib/models';
import { useUi } from '@/store/ui';
import { LOGOS, type LogoId } from './registry';
import { companyLogo, harnessLogo, modelLogo } from './resolve';

export type LogoTone = 'auto' | 'mono' | 'brand';

/** Gap from a logo to its text, by logo size (spec 8.4). */
export function logoGap(size: number): number {
  if (size <= 13) return 5;
  if (size <= 14) return 7;
  if (size <= 16) return 8;
  return 14;
}

interface MarkBaseProps {
  size?: number;
  tone?: LogoTone;
  className?: string;
  style?: CSSProperties;
  /** Set when the mark stands alone without its name (juror stacks, tallies). */
  label?: string;
  /** Monogram source when the id is unknown. */
  fallbackName?: string;
}

/** Make gradient ids unique per instance so repeated marks never share defs. */
function scopeIds(svg: string, scope: string): string {
  if (!svg.includes('id="')) return svg;
  return svg.replace(/id="([^"]+)"/g, `id="$1-${scope}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-${scope})`);
}

export function Logo({ id, size = 14, tone = 'mono', className, style, label, fallbackName }: MarkBaseProps & { id: LogoId | undefined }) {
  const logos = useUi((s) => s.logos);
  const theme = useUi((s) => s.resolved);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const def = id ? LOGOS[id] : undefined;
  const brand = tone === 'brand' && logos === 'brand' && !!def?.color && (!def.colorOn || def.colorOn === theme);
  const svg = useMemo(() => (def ? scopeIds(brand ? def.color! : def.mono, uid) : ''), [def, brand, uid]);
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  if (!def) return <Monogram name={fallbackName || label || '?'} size={size} className={className} style={style} {...a11y} />;
  return (
    <span
      {...a11y}
      data-logo={def.id}
      className={cn('inline-block shrink-0 align-[-0.16em] leading-none [&>svg]:block', className)}
      style={{ width: size, height: size, ...style }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** 1 or 2 letters in a hairline square, for providers without a mark (spec 8.5). */
export function Monogram({ name, size = 14, className, style, ...rest }: { name: string; size?: number } & HTMLAttributes<HTMLSpanElement>) {
  const words = name.replace(/[^\p{L}\p{N}\s.-]/gu, '').split(/[\s.-]+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, size >= 18 ? 2 : 1)).toUpperCase();
  return (
    <span
      {...rest}
      className={cn('inline-grid shrink-0 place-items-center rounded-[var(--r-1)] border border-rule-2 align-[-0.16em] leading-none text-fg-2', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62 * (letters.length > 1 ? 0.8 : 1)), fontWeight: 600, fontStretch: '90%', ...style }}
    >
      {letters}
    </span>
  );
}

/** Model family mark for a model ref: anthropic/claude-sonnet-5-5 -> Claude. */
export function ModelMark({ model, fallbackName, ...rest }: MarkBaseProps & { model: string | undefined }) {
  return <Logo id={modelLogo(model)} {...rest} fallbackName={fallbackName || modelName(model)} />;
}

/** Harness mark (Claude Code, Codex, Gemini CLI, OpenCode). Always mono. */
export function HarnessMark({ harness, fallbackName, ...rest }: Omit<MarkBaseProps, 'tone'> & { harness: string | undefined }) {
  return <Logo id={harnessLogo(harness)} {...rest} fallbackName={fallbackName || harnessLabel(harness) || harness} tone="mono" />;
}

/** Company mark for a provider, plan or limit id: claude-max -> Anthropic. */
export function CompanyMark({ provider, fallbackName, ...rest }: MarkBaseProps & { provider: string | undefined }) {
  return <Logo id={companyLogo(provider)} {...rest} fallbackName={fallbackName || providerName(provider)} />;
}

interface NameProps {
  /** Show the mark before the name. Default true. */
  logo?: boolean;
  size?: number;
  tone?: LogoTone;
  className?: string;
  /** Extra text after the name, inside the same nowrap span. */
  suffix?: ReactNode;
}

/**
 * Logo plus display name, the common case.
 * A harness ref shows the harness ("[cc] Claude Code") unless as="model",
 * which shows the model family ("[claude] Opus"), as model pickers do.
 */
export function ModelName({ model, as = 'auto', logo = true, size = 14, tone = 'mono', className, suffix }: NameProps & { model: string | undefined; as?: 'auto' | 'model' }) {
  if (!model) return null;
  const harness = as === 'auto' ? harnessLogo(model) : undefined;
  const name = harness ? harnessLabel(model)! : modelName(model);
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-baseline whitespace-nowrap', className)} style={{ gap: logo ? logoGap(size) : 0 }} title={model}>
      {logo && (harness ? <HarnessMark harness={model} size={size} className="self-center" /> : <ModelMark model={model} size={size} tone={tone} className="self-center" />)}
      <span className="truncate">{name}</span>
      {suffix}
    </span>
  );
}

/** Harness mark plus its name. */
export function HarnessName({ harness, logo = true, size = 14, className, suffix }: NameProps & { harness: string | undefined }) {
  if (!harness) return null;
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-baseline whitespace-nowrap', className)} style={{ gap: logo ? logoGap(size) : 0 }}>
      {logo && <HarnessMark harness={harness} size={size} className="self-center" />}
      <span className="truncate">{harnessLabel(harness) ?? harness}</span>
      {suffix}
    </span>
  );
}

/** Company mark plus a provider or plan name ("Claude Max", "Z.ai"). */
export function CompanyName({ provider, name, logo = true, size = 16, tone = 'mono', className, suffix }: NameProps & { provider: string | undefined; name?: ReactNode }) {
  if (!provider) return null;
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-baseline whitespace-nowrap', className)} style={{ gap: logo ? logoGap(size) : 0 }}>
      {logo && <CompanyMark provider={provider} size={size} tone={tone} className="self-center" />}
      <span className="truncate">{name ?? providerName(provider)}</span>
      {suffix}
    </span>
  );
}

/** A row of standalone marks (juror stack, tally): up to five 14px marks, 3px apart. */
export function MarkStack({ models, size = 14, tone = 'mono', max = 5, className }: { models: string[]; size?: number; tone?: LogoTone; max?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[3px] align-[-0.16em]', className)}>
      {models.slice(0, max).map((m, i) => (
        <ModelMark key={`${m}${i}`} model={m} size={size} tone={tone} label={modelName(m)} />
      ))}
    </span>
  );
}

export { modelName, providerName, harnessLabel, splitRef };
