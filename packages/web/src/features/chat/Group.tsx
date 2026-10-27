/**
 * Jury and debate runs in the log (spec 10.24, 11.2.5): a ballot table, the
 * verdict as a sentence with a tally of juror logos, the rationale, the
 * dissent as a quote, then each juror's full answer behind a quiet button.
 */
import { useMemo, useState } from 'react';
import type { Message, Session } from '@conclave/core/types';
import type { ModelInfo } from '@conclave/core/providers/types';
import { api } from '@/lib/api';
import { attempt, upsertMemory, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { countWord, hhmm, usd } from '@/lib/format';
import { modelName } from '@/lib/models';
import { MarkStack, ModelMark, ModelName } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { Quote, SectionHeading } from '@/components/ui/Section';
import { Knot, LiveStatus, arrived } from '@/components/motion';
import { AuthorLine, LogRow } from './Log';
import { Markdown, StreamedMarkdown } from './Markdown';
import { took } from './ToolRows';
import { COMPOSE_EVENT, jurorSummary, msgText, splitVerdict, verdictWord, type ComposeDetail } from './util';

export interface GroupUnit {
  kind: 'group';
  key: string;
  group: string;
  members: Message[];
  verdict?: Message;
  mode: 'jury' | 'debate';
  /** The owner's message that started the run. */
  question?: Message;
}

export interface JurorRow {
  m: Message;
  pick?: string;
  reason: string;
  failed: boolean;
  running: boolean;
  ms?: number;
  cost?: number;
}

function priceOf(models: ModelInfo[], m: Message): number | undefined {
  const info = models.find((x) => x.ref === m.model);
  if (!info) return undefined;
  if (!info.inputPrice && !info.outputPrice) return 0;
  if (!m.usage) return undefined;
  return ((m.usage.inputTokens ?? 0) * (info.inputPrice ?? 0) + (m.usage.outputTokens ?? 0) * (info.outputPrice ?? 0)) / 1_000_000;
}

/** Ballot rows, tally and winner for a jury run. Shared with the context panel. */
export function analyzeJury(unit: Pick<GroupUnit, 'members' | 'verdict' | 'question'>, streaming: Record<string, true>, running: boolean, models: ModelInfo[]) {
  const rows: JurorRow[] = unit.members.map((m) => {
    const meta = (m.meta ?? {}) as { failed?: boolean; error?: string; durationMs?: number };
    const failed = !!meta.failed || m.stopReason === 'error';
    const live = !!streaming[m.id] || (running && !m.stopReason && !failed && !msgText(m).trim());
    const sum = jurorSummary(m);
    const delta = unit.question ? m.createdAt - unit.question.createdAt : undefined;
    const ms = meta.durationMs ?? (delta !== undefined && delta > 2_000 && delta < 15 * 60_000 ? delta : undefined);
    return { m, pick: failed ? undefined : sum.pick, reason: failed ? (meta.error ?? msgText(m).replace(/^\(failed:\s*|\)$/g, '')) : sum.reason, failed, running: live, ms, cost: priceOf(models, m) };
  });
  const votes = new Map<string, string[]>();
  for (const r of rows) if (r.pick && !r.running) votes.set(r.pick, [...(votes.get(r.pick) ?? []), r.m.model ?? '']);
  const verdictText = unit.verdict ? msgText(unit.verdict) : '';
  const { sentence, rest } = splitVerdict(verdictText);
  const word = verdictWord(sentence).toLowerCase();
  const metaPick = unit.verdict?.meta?.pick as string | undefined;
  const ordered = [...votes.entries()].sort((a, b) => b[1].length - a[1].length);
  const winner = metaPick ?? ordered.find(([k]) => word && word.includes(k.toLowerCase()))?.[0] ?? ordered[0]?.[0];
  const tally = winner ? [...ordered.filter(([k]) => k === winner), ...ordered.filter(([k]) => k !== winner)] : ordered;
  const done = rows.filter((r) => !r.running && !r.failed);
  const agree = winner ? (votes.get(winner)?.length ?? 0) : 0;
  return { rows, tally, winner, sentence, rest, agree, done, pending: rows.filter((r) => r.running).length };
}

export function JuryGroup({ unit, session, streaming, enter }: { unit: GroupUnit; session: Session; streaming: Record<string, true>; /** The run started while the session was open: fade in. */ enter?: boolean }) {
  const groups = useHub((s) => s.models);
  const models = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const running = session.status === 'running';
  const a = useMemo(() => analyzeJury(unit, streaming, running, models), [unit, streaming, running, models]);
  const verdictStreaming = !!(unit.verdict && streaming[unit.verdict.id]);
  const [open, setOpen] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const time = hhmm((unit.members[0] ?? unit.verdict)?.createdAt ?? Date.now());
  const dissent = a.rows.filter((r) => r.pick && a.winner && r.pick !== a.winner && !r.running);
  const okCount = a.rows.filter((r) => !r.failed).length;
  const followWord = okCount === 2 ? 'both' : `all ${countWord(okCount)}`;

  return (
    <div className={cn(enter && 'anim-fade')} id={`msg-${unit.members[0]?.id ?? unit.key}`}>
      <LogRow time={time}>
        <AuthorLine>
          Jury
          <span className="ml-2 font-normal text-fg-3">
            {unit.members.length} {unit.members.length === 1 ? 'juror' : 'jurors'}
            {unit.verdict?.model && <>, judged by {modelName(unit.verdict.model)}</>}
          </span>
        </AuthorLine>
      </LogRow>
      <LogRow>
        {/* Ballot */}
        <div className="-mx-1 mt-1.5 overflow-x-auto px-1 phone:hidden">
          <table className="tbl min-w-[560px]">
            <thead>
              <tr>
                <th className="w-[164px]">Model</th>
                <th className="w-[96px]">Pick</th>
                <th>Main reason</th>
                <th className="r w-[52px]">Time</th>
                <th className="r w-[56px]">Cost</th>
              </tr>
            </thead>
            <tbody>
              {a.rows.map((r) => (
                <BallotRow key={r.m.id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        {/* Phones: the ballot as rows */}
        <div className="hidden phone:block">
          <div className="rows mt-1.5 border-y border-rule">
            {a.rows.map((r) => (
              <PhoneBallotRow key={r.m.id} r={r} />
            ))}
          </div>
        </div>

        {/* Verdict */}
        {unit.verdict && (a.sentence || verdictStreaming) ? (
          <div className="mt-5 border-t-2 border-fg pt-3.5" id={`msg-${unit.verdict.id}`}>
            <div className="text-[12px] text-fg-3 phone:text-[13px]">Verdict</div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
              <p className={cn('max-w-[28ch] text-fg', (a.sentence || 'Judging').length <= 48 ? 't-verdict' : 't-page')}>{a.sentence || 'Judging'}</p>
              {a.tally.length > 0 && <Tally tally={a.tally} winner={a.winner} />}
            </div>
            {a.rest && <StreamedMarkdown text={a.rest} streaming={verdictStreaming} className="mt-3 max-w-[72ch]" />}
            {dissent.length > 0 && !verdictStreaming && (
              <Quote
                className="mt-4 max-w-[72ch] text-[13.5px] leading-[1.55] phone:text-[14.5px]"
                cite={
                  <span className="inline-flex items-center gap-1">
                    {dissent.map((d, i) => (
                      <span key={d.m.id} className="inline-flex items-center">
                        {i > 0 && ', '}
                        <ModelName model={d.m.model} size={13} tone="brand" as="model" />
                      </span>
                    ))}
                    &nbsp;picked {dissent[0].pick}.
                  </span>
                }
              >
                {dissent[0].reason}
              </Quote>
            )}
            {!verdictStreaming && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  busy={busy === 'save' ? 'Saving' : false}
                  disabled={saved}
                  onClick={async () => {
                    setBusy('save');
                    const para = a.rest.split(/\n\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
                    const m = await attempt(() => api().saveMemory({ content: `${session.title}: ${a.sentence}${para && !para.startsWith('|') ? ` ${para}` : ''}`, kind: 'fact', tags: session.tags }), 'Saved as a note.');
                    if (m) {
                      upsertMemory(m);
                      setSaved(true);
                    }
                    setBusy(null);
                  }}
                >
                  {saved ? 'Saved as a note' : 'Save as a note'}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { sessionId: session.id } }));
                  }}
                >
                  Ask {followWord} a follow-up
                </Button>
                {unit.question && (
                  <Button
                    variant="quiet"
                    busy={busy === 'rerun' ? 'Starting' : false}
                    disabled={running}
                    onClick={async () => {
                      setBusy('rerun');
                      await attempt(() => api().send(session.id, { text: msgText(unit.question!) }));
                      setBusy(null);
                    }}
                  >
                    Rerun
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          running && (
            <div className="mt-4 border-t-2 border-rule-2 pt-3 text-[13px] text-fg-3">
              {a.pending > 0 ? (
                <span>
                  Waiting for {a.pending} of {a.rows.length} jurors
                </span>
              ) : (
                <LiveStatus state="thinking" label="Judging" still />
              )}
            </div>
          )
        )}

        {/* Full answers */}
        {a.rows.some((r) => !r.running && !r.failed) && (
          <div className="mt-5 -ml-2 flex flex-wrap items-center gap-1">
            {a.rows
              .filter((r) => !r.running && !r.failed)
              .map((r) => {
                const on = open.includes(r.m.id);
                return (
                  <Button key={r.m.id} variant="quiet" size="sm" aria-expanded={on} className={cn(on && 'bg-hover text-fg')} onClick={() => setOpen((o) => (on ? o.filter((x) => x !== r.m.id) : [...o, r.m.id]))}>
                    <ModelMark model={r.m.model} size={14} tone="brand" />
                    {on ? 'Hide' : 'Read'} {modelName(r.m.model)}'s answer
                  </Button>
                );
              })}
          </div>
        )}
      </LogRow>
      {a.rows
        .filter((r) => open.includes(r.m.id))
        .map((r) => (
          <div key={r.m.id} className="mt-3 anim-fade">
            <LogRow time={hhmm(r.m.createdAt)}>
              <AuthorLine>
                <ModelName model={r.m.model} size={13} as="model" />
                {r.m.author && <span className="ml-2 font-normal text-fg-3">{r.m.author}</span>}
              </AuthorLine>
            </LogRow>
            <LogRow>
              <Markdown text={msgText(r.m)} className="my-1" />
            </LogRow>
          </div>
        ))}
    </div>
  );
}

/** Phones: the ballot row as a list row; time and cost become words, a long reason opens on tap. */
function PhoneBallotRow({ r }: { r: JurorRow }) {
  const [more, setMore] = useState(false);
  const long = r.reason.length > 150;
  const cost = r.failed ? '' : r.cost === 0 ? 'plan' : r.cost !== undefined ? usd(r.cost) : '';
  const meta = [r.ms !== undefined ? took(r.ms) : '', cost].filter(Boolean).join(', ');
  return (
    <div id={`msg-${r.m.id}`} className="py-2.5">
      <div className="flex items-baseline gap-3">
        <ModelName model={r.m.model} size={14} tone="brand" as="model" className="min-w-0 flex-1 text-[15px] font-medium text-fg" />
        <span className={cn('shrink-0 text-[15px] font-semibold', r.failed && 'font-normal text-fault')}>{r.running ? <Knot state="tool" size={14} still label="Answering" /> : r.failed ? 'failed' : r.pick}</span>
      </div>
      {!r.running &&
        (long ? (
          <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="mt-1 block w-full text-left text-[14px] leading-[1.45] text-fg-2">
            <span className={cn(!more && 'line-clamp-3')}>{r.reason}</span>
          </button>
        ) : (
          <p className="mt-1 text-[14px] leading-[1.45] text-fg-2">{r.reason}</p>
        ))}
      {!r.running && meta && <p className="num mt-1 text-[13px] text-fg-3">{meta}</p>}
    </div>
  );
}

function BallotRow({ r }: { r: JurorRow }) {
  const [more, setMore] = useState(false);
  const cut = r.reason.length > 124 && !more ? r.reason.slice(0, Math.max(60, r.reason.lastIndexOf(' ', 112))).replace(/[,;:.]$/, '') : r.reason;
  return (
    <tr id={`msg-${r.m.id}`}>
      <td className="pr-3 whitespace-nowrap">
        <ModelName model={r.m.model} size={14} tone="brand" as="model" className="font-medium text-fg" />
      </td>
      <td className={cn('font-semibold whitespace-nowrap', r.failed && 'font-normal text-fault')}>{r.running ? <Knot state="tool" size={14} still label="Answering" /> : r.failed ? 'failed' : (r.pick ?? '')}</td>
      <td className="leading-[1.5] text-fg-2">
        {r.running ? (
          <span className="text-fg-3">Answering</span>
        ) : (
          <>
            {cut}
            {cut !== r.reason && (
              <>
                {'… '}
                <button type="button" className="link text-[12px]" onClick={() => setMore(true)}>
                  more
                </button>
              </>
            )}
          </>
        )}
      </td>
      <td className="r text-fg-3">{r.ms !== undefined ? took(r.ms) : ''}</td>
      <td className="r text-fg-3">{r.failed ? '' : r.cost === 0 ? 'plan' : r.cost !== undefined ? usd(r.cost) : ''}</td>
    </tr>
  );
}

/** "3 [logos]  1 [logo] Traefik": the winning option first. */
function Tally({ tally, winner }: { tally: Array<[string, string[]]>; winner?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-fg-2" aria-label={tally.map(([k, v]) => `${v.length} for ${k}`).join(', ')}>
      {tally.map(([k, v]) => (
        <span key={k} className="inline-flex items-baseline gap-2">
          <span className="t-stat text-fg-2">{v.length}</span>
          <MarkStack models={v} tone="brand" />
          {k !== winner && <span className="text-[13px] text-fg-3">{k}</span>}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Debate
// ---------------------------------------------------------------------------

export function DebateGroup({ unit, session, streaming, known }: { unit: GroupUnit; session: Session; streaming: Record<string, true>; /** Message ids on screen when the transcript loaded; others fade in. */ known?: ReadonlySet<string> | null }) {
  const cfg = session.modeConfig?.debate;
  const running = session.status === 'running';
  const time = hhmm((unit.members[0] ?? unit.verdict)?.createdAt ?? Date.now());
  const sides = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of unit.members) {
      const side = (m.meta?.side as string | undefined) ?? undefined;
      if (m.model && side && !out.has(m.model)) out.set(m.model, side);
    }
    if (cfg) {
      if (cfg.stanceA && !out.has(cfg.a)) out.set(cfg.a, cfg.stanceA);
      if (cfg.stanceB && !out.has(cfg.b)) out.set(cfg.b, cfg.stanceB);
    }
    return out;
  }, [unit.members, cfg]);
  const rounds = useMemo(() => {
    const out: Message[][] = [];
    unit.members.forEach((m, i) => {
      const n = Number(/round\s*(\d+)/i.exec(m.author ?? '')?.[1] ?? Math.floor(i / 2) + 1);
      (out[n - 1] ??= []).push(m);
    });
    return out.filter(Boolean);
  }, [unit.members]);
  const total = Math.max(cfg?.rounds ?? 0, rounds.length);
  const verdictText = unit.verdict ? msgText(unit.verdict) : '';
  const { sentence, rest } = splitVerdict(verdictText);
  const verdictStreaming = !!(unit.verdict && streaming[unit.verdict.id]);
  const dissent = unit.verdict?.meta?.dissent as string | undefined;

  return (
    <div className={cn(arrived(known, unit.members[0]?.id ?? unit.key) && 'anim-fade')} id={`msg-${unit.members[0]?.id ?? unit.key}`}>
      <LogRow time={time}>
        <AuthorLine>
          Debate
          <span className="ml-2 min-w-0 truncate font-normal text-fg-3">
            {[...sides.entries()].map(([m, side], i) => (
              <span key={m}>
                {i > 0 && ', '}
                {modelName(m)} for {side}
              </span>
            ))}
          </span>
        </AuthorLine>
      </LogRow>
      {rounds.map((list, ri) => (
        <div key={ri} className="mt-4">
          <LogRow>
            <SectionHeading as="h3" className="mb-1">
              Round {ri + 1} of {total}
            </SectionHeading>
          </LogRow>
          {list.map((m) => (
            <div key={m.id} className={cn('mt-2', m.id !== unit.members[0]?.id && arrived(known, m.id) && 'anim-fade')} id={`msg-${m.id}`}>
              <LogRow time={hhmm(m.createdAt)}>
                <AuthorLine>
                  <ModelName model={m.model} size={13} as="model" />
                  {sides.get(m.model ?? '') && <span className="ml-1.5 font-normal text-fg-3">for {sides.get(m.model ?? '')}</span>}
                </AuthorLine>
              </LogRow>
              <LogRow>
                <StreamedMarkdown text={msgText(m)} streaming={!!streaming[m.id]} className="my-1" />
              </LogRow>
            </div>
          ))}
        </div>
      ))}
      {unit.verdict && (sentence || verdictStreaming) ? (
        <LogRow time={hhmm(unit.verdict.createdAt)}>
          <div className="mt-5 border-t-2 border-fg pt-3.5" id={`msg-${unit.verdict.id}`}>
            <div className="text-[12px] text-fg-3 phone:text-[13px]">
              Where they ended up{unit.verdict.model && <>, judged by {modelName(unit.verdict.model)}</>}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
              <p className={cn('max-w-[28ch] text-fg', (sentence || 'Judging').length <= 48 ? 't-verdict' : 't-page')}>{sentence || 'Judging'}</p>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px] text-fg-2">
                {[...sides.entries()].map(([m, side]) => (
                  <span key={m} className="inline-flex items-center gap-2">
                    <ModelMark model={m} size={14} tone="brand" label={modelName(m)} />
                    argued {side}
                  </span>
                ))}
              </div>
            </div>
            {rest && <StreamedMarkdown text={rest} streaming={verdictStreaming} className="mt-3 max-w-[72ch]" />}
            {dissent && <Quote className="mt-4 max-w-[72ch] text-[13.5px]">{dissent}</Quote>}
          </div>
        </LogRow>
      ) : (
        running &&
        rounds.length >= total && (
          <LogRow>
            <div className="mt-4 border-t-2 border-rule-2 pt-3 text-[13px]">
              <LiveStatus state="thinking" label="Judging" still />
            </div>
          </LogRow>
        )
      )}
    </div>
  );
}
