/**
 * Meters (spec 10.9). Two kinds only:
 * - LimitGauge: 24 segmented ticks, for usage limits on Home and Usage
 * - Meter: a 3px bar for everything else (context, cache hits, steps, storage)
 */
import type { ReactNode } from 'react';
import type { LimitState, LimitWindow } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { useNow } from '@/lib/hooks';
import { durationShort, hhmm } from '@/lib/format';
import { CompanyMark, logoGap } from '../logo';
import { Roll } from '../motion/Roll';
import { budgetWords } from '@/lib/accounts';

/** Thresholds from hub config ui.limitWarn / ui.limitFault (defaults 70 and 90). */
export function useLimitThresholds(): { warn: number; fault: number } {
  const ui = useHub((s) => s.config?.ui);
  return { warn: ui?.limitWarn ?? 70, fault: ui?.limitFault ?? 90 };
}

export type LimitTone = 'neutral' | 'warn' | 'fault';

export function limitTone(pct: number, t: { warn: number; fault: number }, blocked?: boolean): LimitTone {
  if (blocked || pct >= t.fault) return 'fault';
  if (pct >= t.warn) return 'warn';
  return 'neutral';
}

const TONE_TEXT: Record<LimitTone, string> = { neutral: 'text-fg', warn: 'text-warn', fault: 'text-fault' };
const TONE_FILL: Record<LimitTone, string> = { neutral: 'var(--meter-on)', warn: 'var(--warn)', fault: 'var(--fault)' };

/** 3px bar. tone="signal" for the live context window of a running session. */
export function Meter({ value, max = 100, label, tone = 'neutral', className }: { value: number; max?: number; label?: string; tone?: 'neutral' | 'signal' | 'warn' | 'fault'; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const fill = tone === 'signal' ? 'var(--signal)' : tone === 'warn' ? 'var(--warn)' : tone === 'fault' ? 'var(--fault)' : 'var(--meter-on)';
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('relative h-[3px] w-full overflow-hidden rounded-[1.5px] bg-meter-off', className)}
    >
      {/* the fill slides in from the left (transform only, nothing lays out); the track clips it */}
      <div className="absolute inset-0 rounded-[1.5px] transition-transform duration-[var(--dur-3)] ease-[var(--ease)]" style={{ transform: `translateX(${pct - 100}%)`, background: fill }} />
    </div>
  );
}

/**
 * Segmented tick gauge: 24 segments, 2px gaps, 8px tall (6 on phones). On
 * segments meter-on below the warn threshold, warn from it, fault from the
 * fault threshold or when the provider is blocking.
 */
export function LimitGauge({ value, label, blocked, segments = 24, className }: { value: number; label: string; blocked?: boolean; segments?: number; className?: string }) {
  const t = useLimitThresholds();
  const pct = blocked ? 100 : Math.max(0, Math.min(100, value));
  const tone = limitTone(pct, t, blocked);
  const on = Math.round((pct / 100) * segments);
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label}, ${Math.round(pct)}%`}
      className={cn('flex h-2 items-stretch gap-[2px] phone:h-1.5', className)}
    >
      {Array.from({ length: segments }, (_, i) => (
        <i key={i} className="min-w-0 flex-1 rounded-[0.5px]" style={{ background: i < on ? TONE_FILL[tone] : 'var(--meter-off)' }} />
      ))}
    </div>
  );
}

/** "5h" -> "5 hours", "7d" -> "Week", "7d opus" -> "Week, Opus", "requests / min" -> "Requests per minute". */
export function windowLabel(name: string): string {
  const n = name.trim().toLowerCase();
  const parts = n.split(/\s+/);
  const base = parts[0];
  const rest = parts.slice(1).join(' ');
  const map: Record<string, string> = { '5h': '5 hours', '1h': 'Hour', '24h': 'Day', '1d': 'Day', daily: 'Day', '7d': 'Week', weekly: 'Week', week: 'Week', monthly: 'Month', '30d': 'Month' };
  if (map[base]) {
    const extra = rest.replace(/\b(prompts?|block)\b/, '').trim();
    return extra ? `${map[base]}, ${extra[0].toUpperCase()}${extra.slice(1)}` : map[base];
  }
  const s = n.replace(/\s*\/\s*min(ute)?\b/, ' per minute').replace(/\s*\/\s*day\b/, ' per day').replace(/\s*\/\s*h(our)?\b/, ' per hour');
  return s[0].toUpperCase() + s.slice(1);
}

/** Per-minute API rate windows are noise unless they are above 50% (spec 11.1). */
export function isRateWindow(w: LimitWindow): boolean {
  return /\/\s*(min|minute|s|sec)\b|per[- ]minute|rpm|tpm/i.test(w.name);
}

/**
 * One window: name (72px column), gauge, percent right aligned in the fill
 * color; under it the reset line ("resets in 1h 22m", "396 of 600 left", or
 * the blocked sentence).
 */
export function LimitRow({ window: w, plan, blocked, compact, className }: { window: LimitWindow; plan: string; blocked?: boolean; compact?: boolean; className?: string }) {
  const t = useLimitThresholds();
  const now = useNow(compact ? 60_000 : 1000);
  const pct = blocked ? 100 : Math.round(w.usedPercent ?? (w.limit ? (1 - (w.remaining ?? 0) / w.limit) * 100 : 0));
  const tone = limitTone(pct, t, blocked);
  const name = windowLabel(w.name);
  const until = w.resetsAt ? durationShort(w.resetsAt - now) : undefined;
  let reset: ReactNode = null;
  if (blocked && w.resetsAt)
    reset = (
      <span className="text-fault">
        Blocked. Resets at <span className="num">{hhmm(w.resetsAt)}</span> (in <Roll value={until!} direction="down" />).
      </span>
    );
  else if (w.kind === 'budget' && w.limit !== undefined)
    reset = (
      <>
        {budgetWords(w)}
        {until && (
          <>
            , resets in <Roll value={until} direction="down" />
          </>
        )}
      </>
    );
  else if (w.limit && w.remaining !== undefined)
    reset = (
      <>
        <Roll value={w.remaining} /> of <span className="num">{w.limit.toLocaleString('en-US')}</span> left
        {until && (
          <>
            , resets in <Roll value={until} direction="down" />
          </>
        )}
      </>
    );
  else if (until && (pct >= t.warn || !compact))
    reset = (
      <>
        resets in <Roll value={until} direction="down" />
      </>
    );
  // the numbers roll in the direction they move (Roll): the percent up as it is used, the reset time down
  return (
    <div className={cn('py-[5px]', className)}>
      <div className="grid grid-cols-[72px_minmax(0,1fr)_44px] items-center gap-3">
        <span className="text-[12px] leading-[1.25] text-fg-3 phone:text-[13px]">{name}</span>
        <LimitGauge value={pct} blocked={blocked} label={`${plan}, ${name}`} />
        <span className={cn('num text-right text-[13px] font-[560]', TONE_TEXT[tone])}>
          <Roll value={`${pct}%`} />
        </span>
      </div>
      {reset && <div className="mt-0.5 pl-[84px] text-[12px] text-fg-3 phone:text-[13px]">{reset}</div>}
    </div>
  );
}

/** "Claude Max" -> ["Claude", "Max"], "ChatGPT Pro · Codex" -> ["ChatGPT", "Pro, Codex"]. */
export function planParts(label: string): [string, string] {
  const clean = label.replace(/\s*·\s*/g, ', ');
  const m = clean.match(/^(Claude|ChatGPT|Z\.ai|Gemini|Anthropic|OpenAI|Google|OpenRouter|GLM)\s+(.+)$/i);
  return m ? [m[1], m[2]] : [clean, ''];
}

/**
 * A plan or provider with its windows (Home Limits, Usage Limits): brand
 * company logo 16 + plan name (500) + plan detail in fg-3, then a LimitRow
 * per window in the hub's order. Sort groups with limitPeak, highest first. `right` sits at the end of the header line
 * ("read from OAuth 2 min ago", a Refresh button).
 */
export function LimitGroup({ limit, compact, right, hideRate = true, className }: { limit: LimitState; compact?: boolean; right?: ReactNode; hideRate?: boolean; className?: string }) {
  const [name, detail] = planParts(limit.label);
  // an account's state is kept under its gateway (cliproxy): the mark is the vendor's, from the label
  const mark = limit.account ? name : limit.provider;
  // windows keep their natural order (5 hours, then week); groups sort by limitPeak
  const windows = limit.windows.filter((w) => !hideRate || !isRateWindow(w) || (w.usedPercent ?? 0) > 50);
  if (!windows.length && !limit.note) return null;
  return (
    <div className={cn('py-3', className)}>
      <div className="mb-1.5 flex items-center text-[13px]" style={{ gap: logoGap(16) }}>
        <CompanyMark provider={mark} size={16} tone="brand" />
        <span className="shrink-0 font-medium text-fg">{name}</span>
        {detail && <span className="min-w-0 truncate text-fg-3">{detail}</span>}
        {right && <span className="ml-auto shrink-0 pl-2 text-[12px] whitespace-nowrap text-fg-3">{right}</span>}
      </div>
      {windows.map((w) => (
        <LimitRow key={w.name} window={w} plan={limit.label} blocked={limit.blocked && (w.usedPercent ?? 0) >= 99} compact={compact} />
      ))}
      {!windows.length && (
        <p className={cn('m-0 text-[12px]', limit.blocked ? 'text-fault' : 'text-fg-3')}>
          {limit.blocked && 'Blocked. '}
          {limit.note}
        </p>
      )}
    </div>
  );
}

/** Highest used percent of a limit (for sorting groups). */
export function limitPeak(l: LimitState): number {
  return l.blocked ? 100 : Math.max(0, ...l.windows.filter((w) => !isRateWindow(w)).map((w) => w.usedPercent ?? 0));
}
