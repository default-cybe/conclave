/**
 * Security mode, the mock (docs/design/SECURITY-MODE.md 1, 3). The composer
 * gets two text pickers: Security Off / On, and once on, the Lane the
 * detector picked from the first message, with the other matched lanes and
 * each lane's routing line (the model per role). A finding shows in the log
 * as a notice of type "finding": its run-and-confirm evidence, then the
 * refuter's votes and the assumptions it could not test.
 *
 * shortcut: the switch and lane live in this tab only (no hub field yet), until PR 5 adds chat.security.
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { Message, Session } from '@conclave/core/types';
import { toast, useHub } from '@/store/store';
import { hhmm } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { StateWord, type StateTone } from '@/components/ui/List';
import { SelectMenu } from '@/components/ui/Select';
import { ModelName } from '@/components/logo';
import { LogRow } from './Log';
import { detectLanes, laneLabel, LANES, type Lane } from './lanes';
import { msgText } from './util';

interface SecState {
  on: boolean;
  lane?: Lane;
  /** Every lane the detector matched, ranked. */
  lanes: Lane[];
}

const useSec = create<{ by: Record<string, SecState> }>(() => ({ by: {} }));

function seeded(s: Session): SecState {
  const m = (s.meta as { security?: { lane?: Lane; lanes?: Lane[] } } | undefined)?.security;
  return m ? { on: true, lane: m.lane, lanes: m.lanes ?? [] } : { on: false, lanes: [] };
}

export function SecurityControls({ session, look = 'text' }: { session: Session; look?: 'text' | 'field' }) {
  const st = useSec((x) => x.by[session.id]) ?? seeded(session);
  const first = useHub((s) => s.messages[session.id]?.find((m) => m.role === 'user'));
  const set = (next: SecState) => useSec.setState((x) => ({ by: { ...x.by, [session.id]: next } }));
  const turnOn = (on: boolean) => {
    if (!on) return set({ on: false, lanes: [] });
    const lanes = first ? detectLanes(msgText(first)) : [];
    set({ on: true, lanes, lane: lanes[0] ?? 'source' });
  };
  const cls = look === 'text' ? 'h-[24px] shrink-0 text-[12px] phone:h-11 phone:text-[14px]' : undefined;
  const lanes = st.lanes;
  const also = lanes.filter((l) => l !== st.lane).map((l) => LANES.find((x) => x.value === l)!.short);
  return (
    <>
      <SelectMenu
        look={look}
        label="Security"
        prefix={look === 'text' ? 'Security' : undefined}
        value={st.on ? 'on' : 'off'}
        onChange={(v) => turnOn(v === 'on')}
        width={320}
        className={cls}
        options={[
          { value: 'off', label: 'Off', text: 'Off', detail: 'A normal session with its own agent.' },
          { value: 'on', label: 'On', text: 'On', detail: 'Loads the security roster and the scope guard. The lane comes from your first message.' },
        ]}
      />
      {st.on && (
        <SelectMenu
          look={look}
          label="Lane"
          prefix={look === 'text' ? 'Lane' : undefined}
          value={st.lane}
          onChange={(lane) => {
            set({ ...st, lane });
            toast({ title: `Lane changed to ${laneLabel(lane)}.`, body: 'Logged on the session. Tools that ran keep their lane.', level: 'info' });
          }}
          width={480}
          className={cls}
          options={[...lanes, ...LANES.map((l) => l.value).filter((l) => !lanes.includes(l))].map((l, i) => {
            const def = LANES.find((x) => x.value === l)!;
            const group = i === 0 ? (lanes.length ? 'Matched in your message' : 'Lanes') : i === lanes.length ? 'Other lanes' : undefined;
            // closed, the picker stays short (1.2): "source · also web"
            return { value: l, label: def.label, text: `${look === 'text' ? def.short : def.label}${l === st.lane && also.length ? ` · also ${also.join(', ')}` : ''}`, detail: def.routing, group };
          })}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

type FindingState = 'confirmed' | 'partial' | 'refuted';

export interface FindingMeta {
  type: 'finding';
  n: number;
  title: string;
  state: FindingState;
  where: string;
  summary: string;
  /** Step 7: the lane oracle's runs and the negative control. */
  oracle?: { model: string; on: string; runs: Array<{ label: string; detail: string; pass: boolean }>; evidence: string; result: string };
  /** Step 5: one refuter call with three lenses. */
  refuter: { model: string; votes: Array<{ lens: string; vote: 'holds' | 'refuted'; reason: string }>; assumptions: Array<{ text: string; tested: boolean; how: string }> };
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
      <span className="text-fg-2 phone:col-span-1">{k}</span>
      <span className="min-w-0 text-fg-3 phone:order-3 phone:col-span-2 phone:-mt-1">{v}</span>
      <StateWord tone={tone} className="text-right text-[12px] phone:text-[13px]">
        {state}
      </StateWord>
    </div>
  );
}

export function FindingBlock({ message }: { message: Message }) {
  const f = message.meta as unknown as FindingMeta;
  const untested = f.refuter.assumptions.filter((a) => !a.tested).length;
  return (
    <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`}>
      <section aria-label={`Finding ${f.n}, ${f.state}`} className="pt-0.5">
        <div className="flex items-baseline gap-3">
          <h3 className="m-0 min-w-0 flex-1 text-[14px] leading-[1.4] font-semibold text-fg phone:text-[15px]">
            <span className="font-normal text-fg-3">Finding {f.n}</span> {f.title}
          </h3>
          <StateWord tone={STATE_TONE[f.state]} className="text-[13px]">
            {f.state}
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
                sec-validator, <ModelName model={f.oracle.model} size={13} />, on <span className="mono">{f.oracle.on}</span>
              </>
            }
          >
            <div className="rows">
              {f.oracle.runs.map((r) => (
                <Row key={r.label} k={r.label} v={r.detail} state={r.pass ? 'pass' : 'fail'} tone={r.pass ? 'ok' : 'fault'} />
              ))}
            </div>
            <CodeBlock code={f.oracle.evidence} lang="http" maxLines={12} className="mt-2" />
            <p className="m-0 mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">
              Saved to <span className="mono">{f.oracle.result}</span>. Auth headers redacted.
            </p>
          </Part>
        ) : (
          <Part title="Run and confirm" meta="not run yet">
            <p className="m-0 py-[7px] text-[13px] text-fg-3 phone:text-[14px]">{f.next}</p>
          </Part>
        )}

        <Part
          title="Refuter"
          meta={
            <>
              sec-refuter, one call, three lenses, <ModelName model={f.refuter.model} size={13} />
            </>
          }
        >
          <div className="rows">
            {f.refuter.votes.map((v) => (
              <Row key={v.lens} k={v.lens} v={v.reason} state={v.vote} tone={v.vote === 'holds' ? 'neutral' : 'fault'} />
            ))}
          </div>
          <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">Votes never mark a finding confirmed. Only the run above does.</p>
        </Part>

        <Part title="Assumptions" meta={untested ? <span className="text-warn">{untested} untested</span> : 'all tested'}>
          <div className="rows">
            {f.refuter.assumptions.map((a) => (
              <Row key={a.text} k={a.tested ? 'tested' : 'untested'} v={<><span className="text-fg">{a.text}</span> {a.how}</>} state={a.tested ? 'checked' : 'in proof plan'} tone={a.tested ? 'ok' : 'warn'} />
            ))}
          </div>
        </Part>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {f.state === 'confirmed' ? (
            <>
              <Button variant="outline" onClick={() => toast({ title: 'Drafting REPORT.md.', body: 'sec-reporter writes a draft only. You submit it.', level: 'info' })}>
                Draft report
              </Button>
              <Button variant="quiet" onClick={() => toast({ title: f.oracle?.result ?? 'RESULT.txt', level: 'info' })}>
                Open RESULT.txt
              </Button>
            </>
          ) : (
            <Button variant="quiet" onClick={() => toast({ title: `Finding ${f.n} parked as partial.`, body: 'It stays in ledger.jsonl with its reason.', level: 'info' })}>
              Park
            </Button>
          )}
        </div>
      </section>
    </LogRow>
  );
}
