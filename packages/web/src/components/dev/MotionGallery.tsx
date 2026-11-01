/**
 * The motion primitives in the gallery (/dev/ui#motion, alone at /dev/motion):
 * the Knot in every state and size, the rope moments, Ink, the Rim, Steps,
 * Fold, Roll, Send to stop, approve and close the gap, card to panel and the
 * toast stack. The Reduce motion switch shows the still frame of each.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Clock, Copy, FileText, Globe, PenLine, Search, SquareTerminal } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { OnOff, Segmented } from '../ui/Field';
import { Page, PageHeader } from '../ui/Page';
import { EmptyState } from '../ui/EmptyState';
import { RunningTasksView } from '@/features/chat/RunningTasks';
import type { RunningTask } from '@/features/chat/liveTasks';
import { Markdown } from '@/features/chat/Markdown';
import { ErrorBody } from '@/features/chat/Notices';
import type { Session } from '@conclave/core/types';
import { Greeting } from '@/features/conversation/Greeting';
import { toast } from '@/store/store';
import { cn } from '@/lib/text';
import {
  AgentGlyph,
  GLYPH_KINDS,
  PET_STATES,
  Pet,
  type GlyphState,
  CardToPanel,
  Fold,
  GapList,
  InkReveal,
  Knot,
  KnotRope,
  LiveStatus,
  Rim,
  Roll,
  SendStopButton,
  Shimmer,
  Steps,
  Swap,
  ropeDuration,
  type KnotState,
  type LiveState,
  type RopeMoment,
  type RimState,
  type Step,
} from '../motion';

const KNOT_STATES: KnotState[] = ['thinking', 'tool', 'waiting', 'paused', 'failed', 'done'];
const KNOT_SIZES = [12, 16, 24, 48, 112];
const KNOT_WORDS: Record<KnotState, string> = {
  thinking: 'Thinking',
  tool: 'Running a tool',
  waiting: 'Waiting on you',
  paused: 'Limit reached',
  failed: 'Failed',
  done: 'Done',
  brand: 'The mark at rest',
};

const REPLY = `Use \`ss\` on madx. It shows the process that owns the port:

\`\`\`sh
sudo ss -ltnp 'sport = :8080'
\`\`\`

- Run it with **sudo**, or the process column stays empty for other users.
- A \`docker-proxy\` line means a container published the port.

The reply keeps streaming and old lines never fade again.`;

const REASONING = [
  'They mean the amdgpu resume hang from March.',
  'Check the 6.18 notes and the Arch tracker for a fix.',
  'If it landed, a reboot into 6.18.1 is enough.',
];
const ANSWER = 'Yes. The fix landed in 6.18, and Arch ships 6.18.1 in core. Update, reboot, and suspend should work again.';

function Demo({ title, note, children, actions, id }: { title: string; note?: string; children: ReactNode; actions?: ReactNode; id: string }) {
  return (
    <section data-demo={id} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        {note && <p className="text-[12px] text-fg-3">{note}</p>}
        {actions && <div className="flex flex-wrap items-center gap-2 phone:w-full">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Appearance > Reduce motion, for this page only. */
function useStillSwitch(): [boolean, (v: boolean) => void] {
  const [still, setStill] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce');
  const initial = useRef<string | undefined>(undefined);
  useEffect(() => {
    initial.current = document.documentElement.dataset.motion;
    return () => {
      if (initial.current) document.documentElement.dataset.motion = initial.current;
      else delete document.documentElement.dataset.motion;
    };
  }, []);
  const set = (v: boolean) => {
    setStill(v);
    if (v) document.documentElement.dataset.motion = 'reduce';
    else if (initial.current === 'reduce') delete document.documentElement.dataset.motion;
    else if (initial.current) document.documentElement.dataset.motion = initial.current;
    else delete document.documentElement.dataset.motion;
  };
  return [still, set];
}

export function MotionPage() {
  return (
    <Page>
      <PageHeader title="Motion" sub="Every motion primitive, in every state." />
      <MotionGallery />
    </Page>
  );
}

export default MotionPage;

export function MotionGallery() {
  const [still, setStill] = useStillSwitch();
  return (
    <div id="motion" className="space-y-12">
      <div className="flex items-center gap-3" data-still-switch>
        <OnOff checked={still} onChange={setStill} label="Reduce motion" />
        <span className="text-[13px] text-fg-2">Reduce motion</span>
        <span className="text-[12px] text-fg-3">Shows the still pose of each one.</span>
      </div>
      <PetDemo />
      <GlyphDemo />
      <KnotStates />
      <KnotReply />
      <KnotHero />
      <RopeMoments />
      <InkDemo />
      <RimDemo />
      <StepsDemo />
      <FoldDemo />
      <RollDemo />
      <SendStopDemo />
      <GapDemo />
      <CardPanelDemo />
      <ToastDemo />
      <LabelsDemo />
    </div>
  );
}

/** The pet in every state, at 64 and at 24. */
function PetDemo() {
  const [n, setN] = useState(0);
  return (
    <Demo
      id="pet"
      title="Pet"
      note="Every state at 64 and 24. Never in a chat reply."
      actions={
        <Button size="sm" variant="outline" onClick={() => setN((v) => v + 1)} data-act="pet-replay">
          Replay
        </Button>
      }
    >
      <div key={n} className="grid grid-cols-5 gap-x-4 gap-y-5 phone:grid-cols-2" data-motion-pets>
        {PET_STATES.map((st) => (
          <div key={st} className="flex items-end gap-3">
            <Pet state={st} size={64} className="text-fg" />
            <span className="flex flex-col gap-1">
              <Pet state={st} size={24} className="text-fg-2" />
              <span className="text-[12px] text-fg-2">{st}</span>
            </span>
          </div>
        ))}
      </div>
      <PetPlaces />
    </Demo>
  );
}

const PILL_TASKS = (waiting: boolean): RunningTask[] => [
  { kind: 'subagent', key: 't:1', toolUseId: 't1', state: 'running', childId: 'c1', background: true, agent: 'builder', description: 'Fix the upload test', startedAt: Date.now() - 99_000, waiting: false },
  { kind: 'subagent', key: 't:2', toolUseId: 't2', state: 'running', childId: 'c2', background: true, agent: 'coder', description: 'Refactor auth', startedAt: Date.now() - 61_000, waiting },
];

// the chat's own failure presentation (Notices.tsx), so the gallery shows what a failed chat draws
const FAILED = { id: 'gallery-failed', status: 'error', error: 'The provider is overloaded', model: 'anthropic/claude-sonnet-5-5' } as Session;

/** Where the pet goes, with the words it sits beside (CHAT-AND-MOTION 1.11). */
function PetPlaces() {
  const tile = 'min-w-0 rounded-[var(--r-3)] border border-rule p-4';
  const cap = 'mb-3 text-[12px] text-fg-3';
  return (
    <div className="mt-8 grid grid-cols-3 gap-4 phone:grid-cols-1" data-pet-places>
      <div className={tile}>
        <p className={cap}>Running tasks, the busiest job</p>
        <RunningTasksView tasks={PILL_TASKS(false)} className="mx-0 px-0 phone:px-0" />
        <RunningTasksView tasks={PILL_TASKS(true)} className="mx-0 mt-2 px-0 phone:px-0" />
      </div>
      <div className={tile}>
        <p className={cap}>The chat header</p>
        <div className="space-y-2.5 text-[13px]">
          <p className="flex items-center gap-1.5">
            <Pet state="waiting" size={24} className="-my-1 text-fg-2" />
            <span className="state-word text-warn">Waiting on you</span>
          </p>
          <p className="flex items-center gap-1.5">
            <Pet state="parked" size={24} className="-my-1 text-fg-2" />
            <span className="text-fg-2">
              Resumes <span className="num">15:42</span>
              <span className="num ml-2 text-fg-3">in 2h 10m</span>
            </span>
          </p>
          <p className="flex items-center gap-1.5">
            <Pet state="failed" size={24} className="-my-1 text-fg-2" />
            <span className="state-word text-fault">Failed</span>
          </p>
        </div>
      </div>
      <div className={tile}>
        <p className={cap}>The limit notice, asleep until the reset</p>
        <p className="flex items-center gap-2 text-[14px] leading-[22px] font-medium text-warn">
          <Pet state="parked" size={24} className="text-fg-2" />
          Claude Max 5 hour limit reached.
        </p>
        <p className="mt-0.5 text-[14px] leading-[1.45] text-fg-2">This session picks up where it stopped when the limit resets.</p>
      </div>
      <div className={tile}>
        <p className={cap}>A run, or setup, is done</p>
        <div className="flex items-end gap-3">
          <Pet state="done" size={64} className="text-fg" />
          <p className="mb-1 text-[14px] text-fg">Done. 6 agents, all passed.</p>
        </div>
      </div>
      <div className={tile}>
        <p className={cap}>A chat failed</p>
        <ErrorBody session={FAILED} lastPrompt="Fix the upload test" />
      </div>
      <div className={tile}>
        <p className={cap}>Inbox, nothing waiting</p>
        <EmptyState pet="done" className="pt-0 pb-0">
          Nothing is waiting on you.
        </EmptyState>
      </div>
    </div>
  );
}

const GLYPH_STATES: GlyphState[] = ['running', 'waiting', 'failed', 'done'];

/** Each agent glyph in each state, at 14 and 32. */
function GlyphDemo() {
  return (
    <Demo id="glyphs" title="Agent glyphs" note="One stroke on a 16 grid. Only the first three running rows of a list move.">
      <div className="overflow-x-auto">
        <table className="tbl min-w-[520px] max-w-[760px]" data-motion-glyphs>
          <thead>
            <tr>
              <th>Type</th>
              {GLYPH_STATES.map((s) => (
                <th key={s}>{s}</th>
              ))}
              <th>32</th>
            </tr>
          </thead>
          <tbody>
            {GLYPH_KINDS.map((k) => (
              <tr key={k}>
                <td className="text-fg-2">{k}</td>
                {GLYPH_STATES.map((s) => (
                  <td key={s}>
                    <AgentGlyph type={k} state={s} className="text-fg align-middle" />
                  </td>
                ))}
                <td>
                  <AgentGlyph type={k} size={32} className="text-fg align-middle" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Demo>
  );
}

function KnotStates() {
  return (
    <Demo id="knot-states" title="Knot" note="Every state at 12, 16, 24, 48 and 112.">
      <div className="overflow-x-auto">
        <table className="tbl min-w-[560px] max-w-[760px]" data-motion-marks>
          <thead>
            <tr>
              <th>State</th>
              {KNOT_SIZES.map((s) => (
                <th key={s} className="r">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KNOT_STATES.map((st) => (
              <tr key={st}>
                <td className="text-fg-2">{st}</td>
                {KNOT_SIZES.map((s) => (
                  <td key={s} className="r">
                    <Knot state={st} size={s} label={`${KNOT_WORDS[st]}, ${s}px`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Demo>
  );
}

const SCRIPT: Array<[KnotState, number]> = [
  ['thinking', 3600],
  ['tool', 3200],
  ['thinking', 1600],
  ['waiting', 2600],
  ['thinking', 1600],
  ['done', 2600],
  ['paused', 5000],
  ['thinking', 2400],
  ['failed', 2600],
];

function KnotReply() {
  const [state, setState] = useState<KnotState>('thinking');
  const [play, setPlay] = useState(false);
  const [since, setSince] = useState(() => Date.now());
  const [resumeAt, setResumeAt] = useState(0);
  const [n, setN] = useState(0);
  const go = (s: KnotState) => {
    setState(s);
    if (s === 'paused') setResumeAt(Date.now() + 5000);
    // the counter restarts when work starts again after a stop
    if ((s === 'thinking' || s === 'tool') && (state === 'done' || state === 'failed' || state === 'paused')) setSince(Date.now());
  };
  useEffect(() => {
    if (!play) return;
    const [s, ms] = SCRIPT[n % SCRIPT.length];
    go(s);
    const t = setTimeout(() => setN((v) => v + 1), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, n]);
  const live: LiveState = state === 'paused' ? 'resuming' : state === 'brand' ? 'done' : state;
  const tool = state === 'tool';
  return (
    <Demo
      id="knot-reply"
      title="Knot through a reply"
      note="Waiting and failed freeze the frame; thinking resumes from it."
      actions={
        <>
          <Segmented size="sm" label="Knot state" value={state} onChange={(v) => (setPlay(false), go(v))} options={KNOT_STATES.map((s) => ({ value: s, label: s }))} />
          <Button size="sm" variant="outline" onClick={() => setPlay((p) => !p)} data-act="knot-play">
            {play ? 'Pause the script' : 'Play a reply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4 rounded-[var(--r-3)] border border-rule p-6 phone:p-4" data-knot-reply>
        <Knot state={state} size={112} label={KNOT_WORDS[state]} />
        <div className="min-w-0 space-y-3">
          <LiveStatus
            state={live}
            size={16}
            label={tool ? 'Searching the web' : undefined}
            detail={tool ? 'caddy tailscale certs' : state === 'waiting' ? 'Allow reading caddyserver.com?' : state === 'failed' ? 'The provider is overloaded.' : state === 'paused' ? 'Claude Max 5 hour limit' : undefined}
            action={
              state === 'failed' ? (
                <button type="button" className="text-[12.5px] font-medium text-fg underline decoration-rule-2 underline-offset-3 hov:decoration-fg-3" onClick={() => go('thinking')}>
                  Retry
                </button>
              ) : undefined
            }
            startedAt={since}
            endedAt={state === 'done' || state === 'failed' ? Date.now() : undefined}
            resumeAt={resumeAt}
            countdown
          />
          <div className="flex items-center gap-2 text-[13px] text-fg-3">
            <Knot state={state} size={16} />
            <span>The same Knot at 16, in a reply line.</span>
          </div>
        </div>
      </div>
    </Demo>
  );
}

function KnotHero() {
  const [n, setN] = useState(0);
  return (
    <Demo
      id="knot-hero"
      title="Knot as the hero"
      note="Over the greeting on the empty chat: 112 on desktop, 96 on phones; 64 on Home. It writes a loop and a half, then settles into the mark, the light at home."
      actions={
        <Button size="sm" variant="outline" onClick={() => setN((v) => v + 1)} data-act="hero-replay">
          Replay
        </Button>
      }
    >
      <div className="grid place-items-center rounded-[var(--r-3)] border border-rule py-10">
        <Greeting key={n} />
      </div>
    </Demo>
  );
}

const ROPE_TILES: Array<{ m: RopeMoment; title: string; note: string; size: number; word?: string }> = [
  { m: 'launch', title: 'Launch', note: 'Cold start of the apps. A tap skips it.', size: 200 },
  { m: 'launchLong', title: 'Launch, first run', note: 'Before Connect, then the name.', size: 200, word: 'Conclave' },
  { m: 'run', title: 'Run', note: 'Waiting on the hub: connecting, pairing, a first load.', size: 168 },
  { m: 'success', title: 'Success', note: 'Paired, back online, an import finished, a friend added.', size: 168 },
  { m: 'receive', title: 'Receive', note: "A friend's share arrives.", size: 142 },
  { m: 'send', title: 'Send', note: 'After sending to a friend.', size: 142 },
];

/** The knot as a rope that ties itself (docs/design/KNOT-MOTION.md): every moment, with replay and a scrubber. */
function RopeMoments() {
  return (
    <Demo id="knot-rope" title="Knot rope" note="One rope slides along its own path, over and under; nothing morphs.">
      <div className="grid grid-cols-2 gap-4 phone:grid-cols-1">
        {ROPE_TILES.map((x) => (
          <RopeTile key={x.m} {...x} />
        ))}
      </div>
    </Demo>
  );
}

function RopeTile({ m, title, note, size, word }: (typeof ROPE_TILES)[number]) {
  const [n, setN] = useState(0);
  const [at, setAt] = useState<number>();
  const total = ropeDuration(m);
  const max = Number.isFinite(total) ? total : 2400;
  const wide = m !== 'run' && m !== 'success';
  return (
    <div data-rope={m} className={cn('flex min-w-0 flex-col gap-3 rounded-[var(--r-3)] border border-rule p-4', (m === 'launch' || m === 'launchLong') && 'col-span-2 phone:col-span-1')}>
      <div className="flex items-center gap-3">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{note}</p>
        <Button
          size="sm"
          variant="outline"
          data-act="rope-replay"
          onClick={() => {
            setAt(undefined);
            setN((v) => v + 1);
          }}
        >
          Replay
        </Button>
      </div>
      <div className="grid place-items-center py-2 [&_svg]:h-auto [&_svg]:max-w-full" data-rope-stage style={{ minHeight: size + (word ? 46 : 0) }}>
        <KnotRope key={n} moment={m} size={size} word={word} at={at} label={title} className={wide ? undefined : 'mx-auto'} />
      </div>
      <input type="range" min={0} max={max} step={10} value={at ?? 0} onChange={(e) => setAt(Number(e.target.value))} aria-label={`${title}, ms`} data-scrub className="w-full accent-[var(--signal)]" />
    </div>
  );
}

function useStream(text: string, words: [number, number] = [1, 6], gap: [number, number] = [60, 180]) {
  const [shown, setShown] = useState('');
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = (delay = 300) => {
    clearTimeout(timer.current);
    setShown('');
    setRunning(true);
    const parts = text.match(/\S+\s*|\s+/g) ?? [];
    let i = 0;
    const step = () => {
      const n = words[0] + Math.floor(Math.random() * (words[1] - words[0] + 1));
      i = Math.min(parts.length, i + n);
      setShown(parts.slice(0, i).join(''));
      if (i < parts.length) timer.current = setTimeout(step, gap[0] + Math.random() * (gap[1] - gap[0]));
      else setRunning(false);
    };
    timer.current = setTimeout(step, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { shown, running, start };
}

function InkDemo() {
  const stream = useStream(REPLY);
  return (
    <Demo
      id="ink"
      title="Ink"
      note="Words 40ms apart, never more than 320ms behind. Nothing moves."
      actions={
        <Button size="sm" variant="outline" onClick={() => stream.start()} data-act="ink-start">
          {stream.running ? 'Streaming' : 'Stream a reply'}
        </Button>
      }
    >
      <div className="min-h-[240px] max-w-[720px]" data-stream>
        <InkReveal active={stream.running}>
          <Markdown text={stream.shown || ' '} streaming={stream.running} className="t-prose text-fg" />
        </InkReveal>
      </div>
    </Demo>
  );
}

const RIM_STATES: RimState[] = ['idle', 'live', 'waiting', 'done', 'failed'];

function RimDemo() {
  const [state, setState] = useState<RimState>('live');
  return (
    <Demo id="rim" title="Rim, Breath, Settle, Fault" note="One light on the composer edge." actions={<Segmented size="sm" label="Rim state" value={state} onChange={setState} options={RIM_STATES.map((s) => ({ value: s, label: s }))} />}>
      <div className="max-w-[640px] py-3">
        <div className="relative rounded-[var(--r-2)] border border-rule-2 bg-sunk px-3 pt-3 pb-2.5" data-rim-host>
          <Rim state={state} />
          <p className="h-11 text-[15px] text-fg-3">{state === 'waiting' ? 'Reply, it will be sent when you answer' : 'Ask a follow up'}</p>
          <div className="flex items-center gap-3 text-[13px] text-fg-3">
            <span>Opus 5.5</span>
            <span className="h-3.5 w-px bg-rule" />
            <span>Effort low</span>
            <SendStopButton className="ml-auto size-[30px]" running={state === 'live'} ready={state !== 'live'} />
          </div>
        </div>
        <p className="mt-3 text-[12.5px] text-fg-3">
          {state === 'live' ? 'Live: the light runs round once every 4s.' : state === 'waiting' ? 'Waiting on you: the edge breathes amber.' : state === 'done' ? 'Done: the light slows, glows evenly and fades.' : state === 'failed' ? 'Failed: the light brakes and stays as a short mark.' : 'Idle: the plain hairline.'}
        </p>
      </div>
    </Demo>
  );
}

const STEPS: Step[] = [
  { icon: <Search strokeWidth={1.5} />, verb: 'Searching the web', target: 'linux 6.18 changes' },
  { icon: <FileText strokeWidth={1.5} />, verb: 'Reading 3 pages', target: 'lwn.net, archlinux.org' },
  { icon: <PenLine strokeWidth={1.5} />, verb: 'Writing' },
];

function StepsDemo() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setI((n) => (n + 1) % STEPS.length), 1800);
    return () => clearInterval(t);
  }, [auto]);
  return (
    <Demo
      id="steps"
      title="Steps"
      note="The old step leaves before the new one arrives."
      actions={
        <Button size="sm" variant="outline" onClick={() => (setAuto(false), setI((n) => (n + 1) % STEPS.length))} data-act="steps-next">
          Next step
        </Button>
      }
    >
      <div className="flex h-6 items-center text-[13.5px]" data-steps>
        <Steps step={STEPS[i]} />
      </div>
    </Demo>
  );
}

function FoldDemo() {
  const [live, setLive] = useState(false);
  const [lines, setLines] = useState(REASONING.length);
  const answer = useStream(ANSWER, [1, 3], [60, 140]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const run = () => {
    timers.current.forEach(clearTimeout);
    setLines(1);
    setLive(true);
    timers.current = [
      setTimeout(() => setLines(2), 700),
      setTimeout(() => setLines(3), 1400),
      // the answer starts in the same frame the fold closes
      setTimeout(() => {
        setLive(false);
        answer.start(0);
      }, 2400),
    ];
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (
    <Demo
      id="fold"
      title="Fold"
      note="The row folds closed in the same frame the answer starts. Click it to open."
      actions={
        <Button size="sm" variant="outline" onClick={run} data-act="fold-run">
          Run a reply
        </Button>
      }
    >
      <div className="max-w-[560px]" data-fold>
        <div className="mb-3 ml-auto w-fit rounded-[var(--r-2)] border border-rule bg-raise px-3 py-1.5 text-[14px]">is my RDNA3 suspend bug fixed yet?</div>
        <Fold live={live} label="Thought for 3s">
          {REASONING.slice(0, lines).map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Fold>
        <InkReveal active={answer.running} className="mt-1.5 min-h-[22px] text-[14px] leading-[1.55] text-fg">
          {answer.shown || (live ? '' : ANSWER)}
        </InkReveal>
        <p className="mt-3 text-[12.5px] text-fg-3">Copy, Retry, Branch</p>
      </div>
    </Demo>
  );
}

function RollDemo() {
  const [tokens, setTokens] = useState(1962);
  const [left, setLeft] = useState(303);
  const [waiting, setWaiting] = useState(3);
  const [run, setRun] = useState(false);
  useEffect(() => {
    if (!run) return;
    const a = setInterval(() => setTokens((n) => n + 18 + Math.floor(Math.random() * 46)), 340);
    const b = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 303)), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [run]);
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Demo
      id="roll"
      title="Roll"
      note="Only changed digits roll, in the direction of change."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setRun((r) => !r)} data-act="roll-run">
            {run ? 'Stop' : 'Count'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setWaiting((n) => (n > 0 ? n - 1 : 3))} data-act="roll-down">
            One fewer
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[12.5px] text-fg-3" data-roll>
        <span>Sonnet 5.5</span>
        <span>
          <Roll value={tokens} className="text-fg-2" /> tokens
        </span>
        <Roll value={`$${(tokens * 0.000015).toFixed(3)}`} className="text-fg-2" />
        <span className="text-warn">
          <Roll value={waiting} /> waiting on you
        </span>
      </div>
      <div className="mt-4 border-t border-rule pt-4">
        <p className="text-[12.5px] text-warn">You reached the 5 hour limit</p>
        <p className="flex items-baseline gap-3">
          <Roll value={clock} direction="down" duration={380} className="text-[30px] font-[560] tracking-[-0.01em] text-fg" />
          <span className="text-[12.5px] text-fg-3">resumes at 15:42</span>
        </p>
      </div>
    </Demo>
  );
}

function SendStopDemo() {
  const [a, setA] = useState(false);
  const [b, setB] = useState(false);
  return (
    <Demo id="send" title="Send to stop" note="Click to send, click again to stop.">
      <div className="flex items-center gap-8">
        <SendStopButton className="size-[30px]" running={a} ready onClick={() => setA((v) => !v)} data-act="send-a" />
        <SendStopButton className="size-11" size={18} running={b} ready ring onClick={() => setB((v) => !v)} data-act="send-b" />
        <span className="text-[12.5px] text-fg-3">30px on desktop, 44px on phones. The second one draws its outline once.</span>
      </div>
    </Demo>
  );
}

interface Approval {
  id: string;
  icon: ReactNode;
  title: string;
  who: string;
  what: string;
}
const APPROVALS: Approval[] = [
  { id: 'a1', icon: <SquareTerminal className="size-4" strokeWidth={1.5} />, title: 'Run a shell command', who: 'Fix flaky upload test, GPT-5.5', what: 'bun test --filter upload' },
  { id: 'a2', icon: <PenLine className="size-4" strokeWidth={1.5} />, title: 'Edit 3 files', who: 'Refactor auth middleware, Opus 5.5', what: 'src/auth/session.ts  +42  -18' },
  { id: 'a3', icon: <Globe className="size-4" strokeWidth={1.5} />, title: 'Fetch a web page', who: 'Audit Caddy routes, Kimi K3', what: 'caddyserver.com/docs/caddyfile' },
];

function GapDemo() {
  const [items, setItems] = useState(APPROVALS);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const n = useRef(3);
  const allow = (id: string) => {
    setDone((d) => ({ ...d, [id]: true }));
    // the button confirms in place first, then the card goes
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 480);
  };
  const add = () => {
    n.current++;
    const src = APPROVALS[n.current % APPROVALS.length];
    setItems((list) => [{ ...src, id: `a${n.current}` }, ...list]);
  };
  return (
    <Demo
      id="gap"
      title="Approve and close the gap"
      note="The label swaps, the card slides away, the rest close the gap."
      actions={
        <>
          <span className="text-[12.5px] text-warn">
            <Roll value={items.length} /> waiting on you
          </span>
          <Button size="sm" variant="outline" onClick={add} data-act="gap-add">
            Add one
          </Button>
        </>
      }
    >
      <GapList items={items} keyOf={(a) => a.id} className="max-w-[600px] space-y-2.5" exit="right">
        {(a) => {
          const ok = !!done[a.id];
          return (
            <div className="relative overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 py-3">
              <span className={cn('absolute inset-y-0 left-0 w-0.5 bg-warn transition-opacity duration-[var(--dur-2)]', ok && 'opacity-0')} />
              <span className={cn('absolute inset-y-0 left-0 w-0.5 bg-ok opacity-0 transition-opacity duration-[var(--dur-2)]', ok && 'opacity-100')} />
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-fg-3">{a.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-fg">{a.title}</p>
                  <p className="text-[12px] text-fg-3">{a.who}</p>
                  <p className="mono mt-1.5 truncate text-[11.5px] text-fg-2">{a.what}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end phone:flex-col phone:items-end">
                  <Button size="sm" variant="outline" disabled={ok}>
                    Deny
                  </Button>
                  <Button size="sm" variant={ok ? 'outline' : 'solid'} onClick={() => !ok && allow(a.id)} data-act="gap-allow">
                    <Swap
                      on={ok}
                      off={<span>Allow once</span>}
                    >
                      <span className="inline-flex items-center gap-1.5 text-ok">
                        <Check className="size-3.5" strokeWidth={2} />
                        Allowed once
                      </span>
                    </Swap>
                  </Button>
                </div>
              </div>
            </div>
          );
        }}
      </GapList>
    </Demo>
  );
}

const ROUTINES = [
  { id: 'r1', name: 'Nightly triage', when: 'Every day at 09:00', next: 'Next in 6h' },
  { id: 'r2', name: 'Backup memory', when: 'Sundays at 03:00', next: 'Next in 4d' },
  { id: 'r3', name: 'Weekly review', when: 'Fridays at 17:00', next: 'Next in 1d' },
];

function CardPanelDemo() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Demo id="card" title="Card to panel" note="The card grows into its panel. Esc closes it and focus goes back to the card.">
      <div className="grid max-w-[640px] grid-cols-3 gap-3 phone:grid-cols-1">
        {ROUTINES.map((r) => (
          <CardToPanel
            key={r.id}
            open={open === r.id}
            onOpenChange={(v) => setOpen(v ? r.id : null)}
            label={r.name}
            cardClassName="rounded-[var(--r-3)] border border-rule bg-raise p-3.5 hov:border-rule-2"
            card={
              <span className="block" data-card={r.id}>
                <Clock className="size-4 text-fg-3" strokeWidth={1.5} />
                <span className="mt-4 block text-[13.5px] font-semibold text-fg">{r.name}</span>
                <span className="block text-[12px] text-fg-3">{r.when}</span>
                <span className="mt-4 block text-[11.5px] text-fg-3">{r.next}</span>
              </span>
            }
          >
            <div className="p-5" data-panel={r.id}>
              <div className="flex items-start gap-3">
                <Clock className="mt-0.5 size-4 text-fg-3" strokeWidth={1.5} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-[17px] font-semibold text-fg">{r.name}</h2>
                  <p className="text-[12.5px] text-fg-3">{r.when}, Opus 5.5</p>
                </div>
                <Button size="sm" variant="solid">
                  Run now
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOpen(null)} data-close>
                  Close
                </Button>
              </div>
              <div className="mt-5 border-t border-rule pt-4">
                <p className="text-[12px] font-medium text-fg-3">Recent runs</p>
                {['Oct 12', 'Oct 5', 'Sep 28'].map((d) => (
                  <div key={d} className="flex items-center gap-3 border-b border-rule py-2 text-[12.5px]">
                    <span className="text-fg-2">{d}, 03:00</span>
                    <span className="mono ml-auto text-fg-3">41s</span>
                    <Check className="size-3.5 text-ok" strokeWidth={2} />
                  </div>
                ))}
                <p className="mt-4 text-[12px] font-medium text-fg-3">Prompt</p>
                <p className="mono mt-1.5 rounded-[var(--r-2)] border border-rule bg-sunk p-3 text-[12px] text-fg-2">Export memory to ~/backups/conclave and remove notes older than 90 days. Report what changed.</p>
              </div>
            </div>
          </CardToPanel>
        ))}
      </div>
    </Demo>
  );
}

function ToastDemo() {
  return (
    <Demo id="toast" title="Toast stack" note="Toasts stack; hover fans them out.">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" data-act="toast-saved" onClick={() => toast({ title: 'Routine saved', level: 'success', action: { label: 'View', run: () => {} } })}>
          Save a routine
        </Button>
        <Button size="sm" variant="outline" data-act="toast-copied" onClick={() => toast({ title: 'Link copied' })}>
          Copy a link
        </Button>
        <Button size="sm" variant="outline" data-act="toast-undo" onClick={() => toast({ title: 'Memory updated', action: { label: 'Undo', run: () => toast({ title: 'Change undone' }) } })}>
          Update memory
        </Button>
      </div>
    </Demo>
  );
}

function LabelsDemo() {
  const [copied, setCopied] = useState(false);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const rows: Array<{ state: LiveState; label?: string; detail?: string; startedAt?: number; endedAt?: number; resumeAt?: number; countdown?: boolean }> = [
    { state: 'thinking', startedAt: now - 4_000 },
    { state: 'tool', label: 'Searching the web', detail: 'caddy tailscale certificates', startedAt: now - 2_000 },
    { state: 'writing', startedAt: now - 9_000 },
    { state: 'waiting', detail: 'Run this command on madx?' },
    { state: 'resuming', detail: 'Claude Max 5 hour limit', resumeAt: now + 82 * 60_000, countdown: true },
    { state: 'done', label: 'Thought for {t}', startedAt: now - 12_000, endedAt: now },
    { state: 'failed', detail: 'The hub lost the connection to arch-desktop.' },
    { state: 'stopped' },
  ];
  return (
    <Demo id="labels" title="Live words" note="LiveStatus in every state, Shimmer, and Swap.">
      <div className="flex flex-wrap items-baseline gap-8 text-[14px]">
        <Shimmer className="font-medium text-signal">Thinking</Shimmer>
        <Shimmer className="font-medium text-signal">Searching the web</Shimmer>
        <IconButton label={copied ? 'Copied' : 'Copy'} variant="outline" onClick={() => setCopied(true)} data-swap>
          <Swap on={copied} off={<Copy />}>
            <Check />
          </Swap>
        </IconButton>
      </div>
      <div className="rows mt-4 max-w-[720px]" data-motion-status>
        {rows.map((r) => (
          <div key={r.state} className="flex min-w-0 items-center justify-between gap-4 py-2.5">
            <LiveStatus {...r} className="min-w-0" />
            <span className="mono shrink-0 text-[12px] text-fg-3">{r.state}</span>
          </div>
        ))}
      </div>
    </Demo>
  );
}
