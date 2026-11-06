/**
 * A Security mode finding in the log (docs/design/SECURITY-MODE.md 3.1, the
 * finding card of the mock): a notice of type "finding" that the
 * security-hunt workflow posts with lib.notice. It shows the lane oracle's
 * runs and evidence, the refuter's votes, and the assumptions nobody tested.
 * The hub shows "confirmed" only when the oracle passed (workflows/run.ts
 * notice), so the card takes the state as sent.
 */
import type { ReactNode } from 'react';
import type { Message } from '@conclave/core/types';
import { hhmm } from '@/lib/format';
import { CodeBlock } from '@/components/ui/Code';
import { StateWord, type StateTone } from '@/components/ui/List';
import { ModelName } from '@/components/logo/Logo';
import { LogRow } from './Log';

type FindingState = 'confirmed' | 'partial' | 'refuted';

export interface FindingMeta {
  type: 'finding';
  n: number;
  title: string;
  state: FindingState;
  where: string;
  summary: string;
  /** Step 7: the lane oracle's runs and negative controls. */
  oracle?: { model?: string; on?: string; runs?: Array<{ label: string; detail: string; pass: boolean }>; evidence?: string; result?: string };
  /** Step 5: one refuter call with three lenses. */
  refuter?: { model?: string; votes?: Array<{ lens: string; vote: 'holds' | 'refuted'; reason: string }>; assumptions?: Array<{ text: string; tested: boolean; how: string }> };
  next?: string;
}

const STATE_TONE: Record<FindingState, StateTone> = { confirmed: 'ok', partial: 'warn', refuted: 'fault' };

export const isFinding = (m: Message) => (m.meta as { type?: string } | undefined)?.type === 'finding';

function Part({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-2 border-b border-rule pb-1.5">
        <h4 className="m-0 text-[13px] font-semibold text-fg phone:text-[14px]">{title}</h4>
        {meta && <span className="min-w-0 text-[12px] text-fg-3 phone:text-[13px]">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, state, tone }: { k: string; v: ReactNode; state: string; tone: StateTone }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-[7px] text-[13px] phone:grid-cols-[minmax(0,1fr)_auto] phone:text-[14px]">
      <span className="text-fg-2">{k}</span>
      <span className="min-w-0 text-fg-3 phone:order-3 phone:col-span-2 phone:-mt-1">{v}</span>
      <StateWord tone={tone} className="text-right text-[12px] phone:text-[13px]">
        {state}
      </StateWord>
    </div>
  );
}

export function FindingBlock({ message }: { message: Message }) {
  const f = message.meta as unknown as FindingMeta;
  const state: FindingState = f.state === 'confirmed' || f.state === 'refuted' ? f.state : 'partial';
  const votes = f.refuter?.votes ?? [];
  const assumptions = f.refuter?.assumptions ?? [];
  const untested = assumptions.filter((a) => !a.tested).length;
  const runs = f.oracle?.runs ?? [];
  return (
    <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`}>
      <section aria-label={`Finding ${f.n}, ${state}`} className="pt-0.5">
        <div className="flex items-baseline gap-3">
          <h3 className="m-0 min-w-0 flex-1 text-[14px] leading-[1.4] font-semibold text-fg phone:text-[15px]">
            <span className="font-normal text-fg-3">Finding {f.n}</span> {f.title}
          </h3>
          <StateWord tone={STATE_TONE[state]} className="text-[13px]">
            {state}
          </StateWord>
        </div>
        <p className="m-0 mt-1 text-[13.5px] leading-[1.5] text-fg-2 phone:text-[14.5px]">
          {f.summary} <span className="mono text-fg-3">{f.where}</span>
        </p>

        {f.oracle ? (
          <Part
            title="Run and confirm"
            meta={
              <>
                sec-validator{f.oracle.model && <>, <ModelName model={f.oracle.model} size={13} /></>}
                {f.oracle.on && <>, on <span className="mono">{f.oracle.on}</span></>}
              </>
            }
          >
            <div className="rows">
              {runs.map((r, i) => (
                <Row key={`${i}-${r.label}`} k={r.label} v={r.detail} state={r.pass ? 'pass' : 'fail'} tone={r.pass ? 'ok' : 'fault'} />
              ))}
            </div>
            {f.oracle.evidence && <CodeBlock code={f.oracle.evidence} lang="http" maxLines={12} className="mt-2" />}
            {f.oracle.result && (
              <p className="m-0 mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">
                Saved to <span className="mono">{f.oracle.result}</span>. Auth headers redacted.
              </p>
            )}
            {state !== 'confirmed' && f.next && <p className="m-0 mt-1.5 text-[12px] text-warn phone:text-[13px]">{f.next}</p>}
          </Part>
        ) : (
          <Part title="Run and confirm" meta="not run">
            <p className="m-0 py-[7px] text-[13px] text-fg-3 phone:text-[14px]">{f.next}</p>
          </Part>
        )}

        <Part
          title="Refuter"
          meta={
            <>
              sec-refuter, one call, three lenses{f.refuter?.model && <>, <ModelName model={f.refuter.model} size={13} /></>}
            </>
          }
        >
          <div className="rows">
            {votes.map((v) => (
              <Row key={v.lens} k={v.lens} v={v.reason} state={v.vote} tone={v.vote === 'holds' ? 'neutral' : 'fault'} />
            ))}
          </div>
          <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">Votes never mark a finding confirmed. Only the run above does.</p>
        </Part>

        {assumptions.length > 0 && (
          <Part title="Assumptions" meta={untested ? <span className="text-warn">{untested} untested</span> : 'all tested'}>
            <div className="rows">
              {assumptions.map((a) => (
                <Row
                  key={a.text}
                  k={a.tested ? 'tested' : 'untested'}
                  v={
                    <>
                      <span className="text-fg">{a.text}</span> {a.how}
                    </>
                  }
                  state={a.tested ? 'checked' : 'in proof plan'}
                  tone={a.tested ? 'ok' : 'warn'}
                />
              ))}
            </div>
          </Part>
        )}
      </section>
    </LogRow>
  );
}
