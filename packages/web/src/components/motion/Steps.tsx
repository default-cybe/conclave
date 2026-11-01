import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { usePresenceList } from './usePresence';

/** One step of the live status line. */
export interface Step {
  /** Changes when the step changes. Defaults to verb + target. */
  id?: string;
  /** A 15px stroke icon in fg-3 (lucide, strokeWidth 1.5). */
  icon?: ReactNode;
  /** The verb, sentence case: "Searching the web", "Reading 3 pages", "Writing". */
  verb: string;
  /** Quiet detail after the verb, in fg-3: the query, the hosts. */
  target?: string;
}

export interface StepsProps {
  step: Step;
  className?: string;
  /** Play the entrance for the first step too. Default true. */
  appear?: boolean;
}

/** Old step out: 150ms, parts 10ms apart (at most 30ms). New step in: starts 190ms after the change, once the old one is gone; parts 32ms apart, 300ms each. */
const OUT_MS = 150;
const IN_AT = 190;
const PART_MS = 32;
const PART_DUR = 300;
/** The verb's one pass of light starts this long after the step has landed. */
const GLINT_AFTER = 600;

const keyOf = (s: Step) => s.id ?? `${s.verb}\u0000${s.target ?? ''}`;

/**
 * The live status line (type.html Steps). When the step changes, the old one
 * lifts 4px and fades out in 180ms; then the new one comes up a word at a
 * time, and its verb gets one pass of light 0.6s after it lands. The old
 * step always leaves before the new one arrives, so two never overlap.
 * Transform and opacity only. Reduced motion: the steps swap at once.
 */
export function Steps({ step, className, appear = true }: StepsProps) {
  const list = useMemo(() => [step], [step]);
  const shown = usePresenceList(list, keyOf, IN_AT);
  const first = useMemo(() => keyOf(step), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className={cn('cv-steps', className)}>
      <span className="sr-only" aria-live="polite">
        {[step.verb, step.target].filter(Boolean).join(' ')}
      </span>
      {shown.map(({ item, key, leaving }) => (
        <StepLine key={key} step={item} leaving={leaving} still={!appear && key === first && !leaving} />
      ))}
    </span>
  );
}

function StepLine({ step, leaving, still }: { step: Step; leaving: boolean; still: boolean }) {
  const verbWords = step.verb.split(' ');
  const targetWords = step.target ? step.target.split(' ') : [];
  let i = 0;
  const part = (node: ReactNode, k: string, cls?: string) => (
    <span key={k} data-part className={cls} style={{ '--i': i++ } as CSSProperties}>
      {node}
    </span>
  );
  const parts: ReactNode[] = [];
  if (step.icon) parts.push(part(step.icon, 'icon', 'cv-steps-icon'));
  const verb = verbWords.map((w, j) => part(w, `v${j}`));
  const target = targetWords.map((w, j) => part(w, `t${j}`));
  const landed = IN_AT + Math.max(0, i - 1) * PART_MS + PART_DUR;
  return (
    <span aria-hidden className={cn('cv-steps-line', leaving ? 'cv-steps-out' : still ? '' : 'cv-steps-in')} style={{ '--out': `${OUT_MS}ms`, '--in-at': `${IN_AT}ms`, '--part': `${PART_MS}ms`, '--part-dur': `${PART_DUR}ms` } as CSSProperties}>
      {parts}
      <span className="cv-steps-verb">
        {verb.flatMap((v, j) => (j ? [' ', v] : [v]))}
        {!leaving && !still && <Glint text={step.verb} at={landed + GLINT_AFTER} />}
      </span>
      {target.length > 0 && <span className="cv-steps-target">{target.flatMap((v, j) => (j ? [' ', v] : [v]))}</span>}
    </span>
  );
}

/** One pass of light across the verb: a brighter copy whose letters light up in turn (opacity only). */
function Glint({ text, at }: { text: string; at: number }) {
  return (
    <span className="cv-glint" style={{ '--at': `${at}ms` } as CSSProperties}>
      {Array.from(text).map((c, i) => (
        <span key={i} style={{ '--i': i } as CSSProperties}>
          {c}
        </span>
      ))}
    </span>
  );
}
