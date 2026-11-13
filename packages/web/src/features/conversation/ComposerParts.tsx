/**
 * Parts of the composer, shaped like Claude Code's: one box with "+" at the
 * left, the field, the mic and Send; under it one quiet row with the
 * permission mode (and Code's folder and device, one chip) at the left, and
 * at the right the model with its effort as one picker, the Options chip
 * (style, agent, memory; design review #6; and the switches that go with
 * the conversation's model: Same model for all work, Security, Cyber access,
 * design review #7) and a small ring for the context used (design PR #292).
 * "+" holds files and add-ons only; the rest is behind "/".
 *
 * Effort offers the levels the hub's model list gives each model
 * (ModelInfo.effort, lib/effort.ts), its default marked; a level the next
 * model lacks becomes the nearest one it has.
 *
 * Attachments sit above the field as one row of chips that scrolls sideways
 * at a fixed height (AttachmentStrip), so the field never leaves the screen
 * however many files there are; any number (core attachments/limits.ts).
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'wouter';
import { ChevronDown, FileArchive, FileText, Plus, Settings2, X } from 'lucide-react';
import type { Session, SessionMode } from '@conclave/core/types';
import { claudeEffort } from '@conclave/core/providers/effort';
import { cyberLabel, type CyberProgram } from '@conclave/core/providers/access-programs';
import { filesWord, isZip, mediaTypeFor, takeFiles, UPLOAD_MAX_BYTES } from '@conclave/core/attachments/limits';
import { api } from '@/lib/api';
import { isModelImage, unreadablePicture } from '@conclave/core/attachments/image';
import { asPng, pictureType } from '@/lib/pasteFiles';
import { toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { bytes, compact, usd } from '@/lib/format';
import { worthLine } from '@/features/usage/value';
import { useIsMobile } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { effortLabel, effortMenu, shownEffort, useModelEffort, type EffortSetting, type ModelEffort as EffortLevels } from '@/lib/effort';
import { MenuList, Popover, type MenuItem } from '@/components/ui/Overlay';
import { Segmented } from '@/components/ui/Field';
import { LimitRow } from '@/components/ui/Meter';
import { windowApplies } from '@conclave/core/accounts/windows';
import type { AccountDto } from '@conclave/core/client';
import { STATE_WORD, markedName, rowWindows, sessionPlan, useAccounts, type PlanReason } from '@/lib/accounts';
import { costWord, stateWord } from '@/features/chat/panel';
import { MODES, MORE_STYLES, STYLE_HEADING } from '@/features/chat/modes';
import { ULTRA_LINE } from '@/features/workflows/UltraSwitch';
import { memoryItems, type MemoryMode } from './incognito';
import { PickerButton, SelectMenu } from '@/components/ui/Select';
import { ModelList } from '@/components/pickers/ModelPicker';
import { SwitchModelList } from '@/features/chat/SwitchChoice';
import { SameModelDot } from './PhoneBox';

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/** What runs with nothing picked: the agent's level (`label` names the agent). Unset: the model's default. */
export interface EffortFollow {
  label: string;
  level?: EffortSetting;
}

/**
 * What a session runs at with no Effort of its own (engine.thinkingFor): its
 * agent's level, else medium for a coding agent on a Claude model that takes
 * one, else the model's default.
 */
export function useAgentFollow(agent: string | undefined, model: string | undefined, coding: boolean): EffortFollow {
  const own = useHub((s) => s.agents.find((a) => a.name === agent)?.thinking);
  const level = own ?? (coding && model && claudeEffort(model) ? 'medium' : undefined);
  return { label: `the ${agent ?? 'agent'} agent`, level };
}

/** The setting it runs at, as the model takes it: the one picked, else the agent's, else the model's default. */
export function effortShown(value: EffortSetting | undefined, e: EffortLevels | undefined, follow?: EffortFollow): EffortSetting | undefined {
  return e ? shownEffort(value ?? follow?.level, e) : undefined;
}

/** "Opus 5.5 Medium": the model's name, and the level it runs at when the model has levels (none for Off or a lone level). */
export function modelEffortWords(model: string | undefined, shown: EffortSetting | undefined, e: EffortLevels | undefined): string {
  const name = modelName(model) || 'Choose a model';
  return e && shown && shown !== 'off' && e.levels.length > 1 ? `${name} ${effortLabel(shown, e)}` : name;
}

interface PickerProps {
  model: string | undefined;
  /** The picked setting; unset runs at `follow`'s level, else the model's default. */
  value: EffortSetting | undefined;
  follow?: EffortFollow;
  onModel: (ref: string) => void;
  /** Undefined goes back to what `follow` names. */
  onEffort: (v: EffortSetting | undefined) => void;
  harnesses?: boolean;
  /**
   * A session with history: a pick switches it (features/chat/SwitchChoice.tsx),
   * showing the price and the choices first in a big chat, instead of calling onModel.
   */
  switchOf?: Session;
  /** Same model for all work is on: a dot on the chip. Its switch is in Options (design review #7). */
  sameModel?: boolean;
}

export const SECURITY_HELP = 'Loads the security agent and its sec-* roles, and checks every network call against scope.yaml. Off brings back the agent you had.';

export const SAME_MODEL_HELP = 'Delegate, Task and workflow agents, at any depth, run on this conversation\'s model unless you name another. If its plan is out or refuses, the usual fallback order applies.';

/** The Cyber access programs a model takes (ModelInfo.cyber); none where there is no choice. */
const useCyberChoices = (model: string | undefined) => useHub((s) => (model ? s.models.flatMap((g) => g.models).find((m) => m.ref === model)?.cyber : undefined));

/** Cyber access for a ChatGPT plan model (core providers/access-programs.ts): Default sends nothing, else the program. */
export function CyberAccess({ model, value, onChange }: { model: string | undefined; value: CyberProgram | undefined; onChange: (v: CyberProgram | undefined) => void }) {
  const choices = useCyberChoices(model);
  if (!choices?.length) return null;
  const opts: Array<CyberProgram | undefined> = [undefined, ...choices];
  return (
    <div className="shrink-0 space-y-2 border-b border-rule px-3 pt-2 pb-2.5">
      <div className="text-[12px] text-fg-3 phone:text-[13px]">Cyber access</div>
      <div role="radiogroup" aria-label="Cyber access" className="flex flex-wrap gap-1.5">
        {opts.map((o) => (
          <button key={o ?? 'default'} type="button" role="radio" aria-checked={value === o || (!o && !value)} className={cn('rounded-md border border-rule px-2 py-0.5 text-[12px]', value === o || (!o && !value) ? 'bg-fg text-bg' : 'text-fg-2 hov:text-fg')} onClick={() => onChange(o)}>
            {o ? cyberLabel(o) : 'Default'}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The picker's body: Effort for the model on top as one compact row (when it
 * has levels), then the model list. The switches that used to sit in a
 * Settings drawer at the foot are in Options (design review #7).
 */
function ModelEffortBody({ model, value, follow, onModel, onEffort, harnesses = false, onDone, switchOf }: PickerProps & { onDone: () => void }) {
  const e = useModelEffort(model);
  const mobile = useIsMobile();
  const shown = effortShown(value, e, follow);
  const [stepping, setStepping] = useState(false);
  // Effort above the search, as before #298 (the owner asked for it back on top); one row: the word, the levels, Reset
  return (
    <>
      {e && !stepping && (
        <div data-part="effort" className="flex shrink-0 items-center gap-2 border-b border-rule px-2.5 py-1.5 text-[12px] phone:gap-1.5 phone:px-2 phone:text-[13px]">
          <span className="shrink-0 text-fg-3" title={follow && !value ? `As ${follow.label} sets` : undefined}>
            Effort
          </span>
          <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
            <EffortSegments effort={e} value={shown} onChange={(v) => onEffort(v)} size={mobile ? 'touch' : 'sm'} />
          </div>
          {follow && value && (
            <button type="button" title={`Use ${follow.label}'s`} aria-label={`Use ${follow.label}'s`} className="shrink-0 rounded-[var(--r-1)] px-1 text-fg-3 hov:text-fg phone:min-h-11 phone:px-2" onClick={() => onEffort(undefined)}>
              Reset
            </button>
          )}
        </div>
      )}
      {switchOf ? <SwitchModelList session={switchOf} harnesses={harnesses} onDone={onDone} onStep={setStepping} /> : <ModelList value={model} harnesses={harnesses} onChange={onModel} onDone={onDone} />}
    </>
  );
}

/**
 * The model and its effort as one picker, in the quiet row: "Opus 5.5 Medium".
 * With `session` its tooltip also says the context left and the cost, the
 * numbers the status line under the composer used to show.
 */
export function ModelEffort({ className, session, ...p }: PickerProps & { className?: string; session?: Session }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const e = useModelEffort(p.model);
  const words = modelEffortWords(p.model, effortShown(p.value, e, p.follow), e);
  const u = useContextUse(session, p.model);
  const use = session ? `${u.window ? `, ${100 - Math.round(u.share * 100)}% context left` : ''}, ${u.word}` : '';
  return (
    <>
      <PickerButton ref={ref} look="text" lead={p.sameModel ? <SameModelDot /> : undefined} data-chip="model" title={`${words}${use}`} aria-label={`Model and effort, ${words}${p.sameModel ? ', same model for all work' : ''}${use}`} aria-haspopup="dialog" aria-expanded={open} className={cn(CHIP, className)} onClick={() => setOpen((o) => !o)}>
        {words}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-end" width={400} maxHeight={520} label="Model and effort" sheetTitle="Model and effort">
        <ModelEffortBody {...p} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/**
 * Effort as a menu (the /model sheet's field, tests): "Effort High", the
 * levels the model has with its default marked. Unset shows the default, or
 * `follow` (the agent's level) when given.
 */
export function EffortMenu<F extends string = never>({
  effort,
  value,
  onChange,
  look = 'text',
  follow,
}: {
  effort: EffortLevels;
  value: EffortSetting | undefined;
  onChange: (v: EffortSetting | F) => void;
  look?: 'text' | 'field';
  follow?: { value: F; label: string; detail?: string };
}) {
  const shown: EffortSetting | F | undefined = value ? shownEffort(value, effort) : follow ? follow.value : shownEffort(undefined, effort);
  return <SelectMenu look={look} label="Effort" prefix={look === 'text' ? 'Effort' : undefined} placeholder="Default" value={shown} onChange={onChange} options={effortMenu(effort, follow)} width={look === 'text' ? 200 : undefined} />;
}

/** Effort as segments: the same levels, the default marked in its tooltip. */
export function EffortSegments<F extends string = never>({
  effort,
  value,
  onChange,
  follow,
  size = 'touch',
  full = true,
}: {
  effort: EffortLevels;
  value: EffortSetting | undefined;
  onChange: (v: EffortSetting | F) => void;
  follow?: { value: F; label: string };
  size?: 'sm' | 'touch';
  full?: boolean;
}) {
  const shown = value ? shownEffort(value, effort) : follow ? follow.value : shownEffort(undefined, effort);
  const options = effortMenu(effort, follow).map((o) => ({ value: o.value, label: o.text ?? effortLabel(o.value as EffortSetting, effort), title: o.hint ? `${o.text}, the default` : undefined }));
  // six touch-size segments overflow a phone; the small ones keep a 44px place to tap there
  return <Segmented full={full} size={size === 'touch' && options.length > 5 ? 'sm' : size} label="Effort" value={(shown ?? '') as EffortSetting | F} onChange={onChange} options={options} />;
}

// ---------------------------------------------------------------------------
// Context ring
// ---------------------------------------------------------------------------

/** What a conversation used: the last reply's context against the window, its tokens and cost. */
function useContextUse(session: Session | undefined, model: string | undefined) {
  const messages = useHub((s) => (session ? s.messages[session.id] : undefined));
  const groups = useHub((s) => s.models);
  return useMemo(() => {
    const info = groups.flatMap((g) => g.models).find((m) => m.ref === (session?.model ?? model));
    const last = [...(messages ?? [])].reverse().find((m) => m.usage)?.usage;
    const used = last ? last.inputTokens + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0) : 0;
    const window = info?.contextWindow ?? 0;
    const st = session?.stats;
    const word = st ? costWord(st, session?.model, info) : usd(0);
    return { used, window, share: window ? Math.min(1, used / window) : 0, tokensIn: st ? st.inputTokens + st.cacheReadTokens : 0, tokensOut: st?.outputTokens ?? 0, word, cost: `${word}${worthLine(st) ? `, ${worthLine(st)}` : ''}` };
  }, [messages, groups, session, model]);
}

const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', fault: 'text-fault', dim: 'text-fg-3', live: 'text-fg' };

/** "neu-claude, Max 20x": a plan by its short name and its plan, a key by its label. */
const planWords = (a: AccountDto) => [markedName(a), a.plan].filter(Boolean).join(', ');

/** One plan or key: its name, its state when not ready, and the windows that limit this model (as on Usage). */
function PlanLimits({ a, model }: { a: AccountDto; model: string }) {
  const state = STATE_WORD[a.state];
  const windows = rowWindows(a).filter((w) => windowApplies(w, model));
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px] phone:text-[15px]">
        <span className="min-w-0 truncate text-fg">{planWords(a)}</span>
        {state.tone !== 'ok' && <span className={cn('shrink-0 text-[12px] phone:text-[13px]', TONE_TEXT[state.tone])}>{state.word}</span>}
      </div>
      {windows.map((w) => (
        <LimitRow key={w.name} window={w} plan={planWords(a)} blocked={a.state === 'limited' && (w.usedPercent ?? 0) >= 99} />
      ))}
    </div>
  );
}

/** The plan or key the session's model runs on, why, and the others that serve it (GET /api/accounts). */
function PlanSection({ session, model }: { session?: Session; model: string }) {
  const { status } = useAccounts();
  const agentModel = useHub((s) => s.agents.find((a) => a.name === session?.agent)?.model);
  const hubDefault = useHub((s) => s.hub?.defaultModel);
  const plan = sessionPlan(model, session?.meta, agentModel ?? hubDefault, status);
  if (!plan) return null;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const why = (r: PlanReason) =>
    r.kind === 'fallback' ? `Usage fallback: ${modelName(r.from)} hit its limit. It goes back once that is ready.` : r.kind === 'switched' ? `${r.was ? markedName(r.was) : modelName(r.from)} hit its limit, so it moved here until that resets.` : r.kind === 'picked' ? 'Picked for this conversation.' : 'The default model.';
  const route = plan.current && !plan.pinned ? ' First ready plan in your order.' : '';
  return (
    <div className="border-b border-rule p-3">
      <dl className="m-0 space-y-1.5 text-[13px] phone:text-[15px]">
        <Row k="Model">{modelName(model)}</Row>
        <Row k="On">{plan.current ? planWords(plan.current) : 'No plan or key ready'}</Row>
      </dl>
      <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">
        {why(plan.reason)}
        {route}
      </p>
      {plan.current && <PlanLimits a={plan.current} model={bare} />}
      {plan.others.length > 0 && (
        <>
          <div className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">Also serves it</div>
          {plan.others.map((a) => (
            <PlanLimits key={a.id} a={a} model={bare} />
          ))}
        </>
      )}
    </div>
  );
}

/** A 14px ring filled by the share of the context window in use; a click says the numbers, and the plan the model runs on. */
export function ContextRing({ session, model }: { session?: Session; model?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const u = useContextUse(session, model);
  const r = 5.25;
  const c = 2 * Math.PI * r;
  const pct = Math.round(u.share * 100);
  const label = u.used ? `Context, ${pct}% used` : 'Context, nothing used yet';
  return (
    <>
      <button ref={ref} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid size-6 shrink-0 place-items-center rounded-full text-fg-3 hov:bg-hover hov:text-fg phone:size-9">
        <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke="var(--rule-2)" strokeWidth="1.5" />
          <circle cx="7" cy="7" r={r} fill="none" stroke={u.share > 0.8 ? 'var(--warn)' : 'currentColor'} strokeWidth="1.5" strokeDasharray={c} strokeDashoffset={c * (1 - u.share)} strokeLinecap="round" />
        </svg>
      </button>
      <ContextDetails anchor={ref} open={open} onClose={() => setOpen(false)} session={session} model={model} />
    </>
  );
}

/** The ring's popover (a sheet on phones): the plan and its limits, context, tokens, cost and state, and Usage. */
function ContextDetails({ anchor, open, onClose, session, model }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; session?: Session; model?: string }) {
  const u = useContextUse(session, model);
  const running = session?.model ?? model;
  const pct = Math.round(u.share * 100);
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-end" width={340} maxHeight={520} label="Context" sheetTitle="Context">
      {running && <PlanSection session={session} model={running} />}
      <dl className="m-0 space-y-1.5 p-3 text-[13px] phone:text-[15px]">
        <Row k="Context">{u.window ? `${compact(u.used)} of ${compact(u.window)}${u.used ? `, ${pct}%` : ''}` : u.used ? compact(u.used) : 'Nothing used yet'}</Row>
        {session && (
          <>
            <Row k="Tokens">{`${compact(u.tokensIn)} in, ${compact(u.tokensOut)} out`}</Row>
            <Row k="Cost">{u.cost}</Row>
            <Row k="State">{stateWord(session.status, session.resumeAt).word}</Row>
          </>
        )}
      </dl>
      <div className="border-t border-rule px-3 py-2 text-[12px] phone:text-[13px]">
        <Link href="/usage" className="link" onClick={onClose}>
          Usage
        </Link>
      </div>
    </Popover>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-fg-3">{k}</dt>
      <dd className="num m-0 text-right text-fg">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "+"
// ---------------------------------------------------------------------------

/** "+": attach files first, then the add-ons (search the web, a GitHub repository, a worktree, a design direction). */
export function PlusMenu({ items, onFiles, accept, label = 'Add files and more' }: { items: MenuItem[]; onFiles: (files: File[]) => void; /** Any file when left out. */ accept?: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const all: MenuItem[] = [{ label: 'Attach files and images', onSelect: () => setTimeout(() => input.current?.click(), 0) }, ...(items.length ? [{ separator: true, label: '' }, ...items] : [])];
  return (
    <>
      <button ref={ref} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid size-[30px] shrink-0 place-items-center rounded-full text-fg-2 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg aria-expanded:bg-hover aria-expanded:text-fg">
        <Plus className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          // cleared, so picking the same file again (after removing it) still fires
          e.target.value = '';
          if (list.length) onFiles(list);
        }}
      />
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-start" width={300} maxHeight={520} label={label}>
        <MenuList items={all} onDone={() => setOpen(false)} label={label} />
      </Popover>
    </>
  );
}

/** The quiet row under the box: the left side, then the chips, the model and the ring at the right. Phones (`wrap`): one run that wraps, as the mock. */
export function QuietRow({ left, right, wrap }: { left?: ReactNode; right: ReactNode; wrap?: boolean }) {
  if (wrap)
    return (
      <div data-chip-row="" className="mt-1 flex flex-wrap items-center gap-x-1 px-1 text-[13px] text-fg-3">
        {left}
        {right}
      </div>
    );
  return (
    // with the chips the row can outgrow a narrow column: the right side goes under the left, nothing is cut to "Ask bef..."
    <div className="mt-1 flex min-h-[26px] flex-wrap items-center gap-x-2 px-0.5 text-[12px] text-fg-3">
      <div className="-my-1 flex min-w-0 items-center gap-0.5 py-1 [&>*]:shrink-0">{left}</div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">{right}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Options: style (the session mode), agent and memory in one chip (design review #6)
// ---------------------------------------------------------------------------

/** The chips' size: the quiet row's on desktop, a 36px place to tap on phones. */
export const CHIP = 'h-[24px] text-[12px] phone:h-9 phone:text-[13px]';

/** A compact chip under the box that opens a menu (a sheet on phones). */
export function ChipMenu({ label, words, spoken = typeof words === 'string' ? words : label, items, width = 300, className, onClose }: { label: string; words: ReactNode; /** What a screen reader says after the label, when the chip shows less. */ spoken?: string; items: MenuItem[]; width?: number; className?: string; onClose?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => (setOpen(false), onClose?.());
  return (
    <>
      <PickerButton ref={ref} look="text" data-chip={label.toLowerCase()} aria-label={`${label}, ${spoken}`} title={spoken === words ? undefined : spoken} aria-haspopup="menu" aria-expanded={open} className={cn(CHIP, className)} onClick={() => (open ? close() : setOpen(true))}>
        {words}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={close} placement="top-end" width={width} maxHeight={520} label={label} sheetTitle={label}>
        <MenuList items={items} onDone={close} label={label} />
      </Popover>
    </>
  );
}

export const MEMORY_WORDS: Record<MemoryMode, string> = { save: 'Memory', use: 'Memory, use only', off: 'No memory' };

/** The style part of Options: the session mode, and Ultra where the session takes it (`onUltra`). */
export interface StyleOption {
  mode: SessionMode;
  onMode: (m: SessionMode) => void;
  ultra?: boolean;
  onUltra?: (on: boolean) => void;
}

/** The agent part of Options: the ones offered here, the default first (Code: coder, then the custom ones). */
export interface AgentOption {
  value: string | undefined;
  agents: Array<{ name: string; description?: string }>;
  onChange: (name: string) => void;
}

/**
 * The switches that go with the conversation's model (design review #7: they
 * left the model picker's foot). Each shows only where its handler is given:
 * Same model for all work and Security on a conversation that exists, Cyber
 * access where the model takes a program.
 */
export interface TurnOption {
  model?: string;
  /** session.chat.cyber; undefined is Default: nothing sent. */
  cyber?: CyberProgram;
  onCyber?: (v: CyberProgram | undefined) => void;
  /** session.chat.sameModel: a switch of this conversation only. */
  sameModel?: boolean;
  onSameModel?: (on: boolean) => void;
  /** session.chat.security. */
  security?: boolean;
  onSecurity?: (on: boolean) => void;
}

/** Changes the chip always spells out, never folded into "+1": the risky ones (design review, "never hidden"). */
const RISKY = new Set(['No memory', 'Security']);

/**
 * What Options has changed from the defaults, in words: memory first, so "No
 * memory" is never the part left out, then Security, the style ("Plan"),
 * Ultra, an agent other than the default, Same model and a Cyber access program.
 */
export function optionsChanges({ style, agent, memory, turn }: { style?: Pick<StyleOption, 'mode' | 'ultra' | 'onUltra'>; agent?: Pick<AgentOption, 'value' | 'agents'>; memory?: MemoryMode; turn?: TurnOption }): string[] {
  const mode = style && style.mode !== 'agent' ? MODES.find((m) => m.value === style.mode)?.label : undefined;
  const custom = agent?.value && agent.value !== agent.agents[0]?.name ? agent.value : undefined;
  return [
    memory && memory !== 'save' ? MEMORY_WORDS[memory] : undefined,
    turn?.onSecurity && turn.security ? 'Security' : undefined,
    mode,
    style?.onUltra && style.ultra ? 'Ultra' : undefined,
    custom,
    turn?.onSameModel && turn.sameModel ? 'Same model' : undefined,
    turn?.onCyber && turn.cyber ? cyberLabel(turn.cyber) : undefined,
  ].filter((w): w is string => !!w);
}

/** The chip's words: "Options" at the defaults, else the first change, any risky one, and how many more ("No memory, Security +1"). */
export function optionsWords(changes: string[]): string {
  if (!changes.length) return 'Options';
  const said = changes.filter((c, i) => i === 0 || RISKY.has(c));
  const more = changes.length - said.length;
  return `${said.join(', ')}${more ? ` +${more}` : ''}`;
}

/**
 * "Options" (design review #6): one chip for how a turn runs, in place of the
 * agent, style and memory chips. Its menu: Working style (Agent, Chat, Plan,
 * then a "More styles" fold with Jury, Debate, Loop and Ultra, design review
 * #4), the agent (Code), memory, then the conversation's switches (`turn`:
 * Same model for all work, Security, Cyber access; design review #7). The
 * fold starts open while one of those is on; a toggle by hand lasts until
 * the menu closes. Nothing to offer (a new incognito chat on a model with no
 * Cyber access): no chip.
 */
export function OptionsChip({ style, agent, memory, turn }: { style?: StyleOption; agent?: AgentOption; memory?: { value: MemoryMode; onChange: (m: MemoryMode) => void }; turn?: TurnOption }) {
  const [fold, setFold] = useState<boolean>();
  const phone = useIsMobile();
  const cyberChoices = useCyberChoices(turn?.onCyber ? turn.model : undefined);
  const items: MenuItem[] = [];
  if (style) {
    const { mode, onMode, ultra, onUltra } = style;
    const cur = MODES.find((m) => m.value === mode) ?? MODES[0];
    const more = fold ?? (!!cur.more || (!!onUltra && !!ultra));
    const row = (m: (typeof MODES)[number]): MenuItem => ({ label: m.label, detail: m.description, checked: m.value === mode, onSelect: () => m.value !== mode && onMode(m.value) });
    items.push(
      { group: true, label: STYLE_HEADING },
      ...MODES.filter((m) => !m.more).map(row),
      { separator: true, label: '' },
      { label: MORE_STYLES, hint: <ChevronDown size={14} className={cn('transition-transform', more && 'rotate-180')} aria-hidden />, expanded: more, keep: true, onSelect: () => setFold(!more) },
      ...(more ? MODES.filter((m) => m.more).map(row) : []),
      // Ultra off keeps the fold open under the row just used
      ...(more && onUltra ? [{ label: 'Ultra', detail: ULTRA_LINE, checked: !!ultra, keep: true, onSelect: () => (setFold(true), onUltra(!ultra)) }] : []),
    );
  }
  if (agent) {
    if (items.length) items.push({ separator: true, label: '' });
    items.push({ group: true, label: 'Agent' }, ...agent.agents.map((a) => ({ label: a.name, detail: a.description, checked: a.name === agent.value, onSelect: () => a.name !== agent.value && agent.onChange(a.name) })));
  }
  if (memory) {
    if (items.length) items.push({ separator: true, label: '' });
    items.push(...memoryItems(memory.value, memory.onChange));
  }
  if (turn?.onSameModel || turn?.onSecurity) {
    if (items.length) items.push({ separator: true, label: '' });
    items.push({ group: true, label: 'This conversation' });
    if (turn.onSameModel) items.push({ label: 'Same model for all work', detail: SAME_MODEL_HELP, checked: !!turn.sameModel, keep: true, onSelect: () => turn.onSameModel!(!turn.sameModel) });
    if (turn.onSecurity) items.push({ label: 'Security', detail: SECURITY_HELP, checked: !!turn.security, keep: true, onSelect: () => turn.onSecurity!(!turn.security) });
  }
  if (turn?.onCyber && cyberChoices?.length) {
    if (items.length) items.push({ separator: true, label: '' });
    items.push({ group: true, label: 'Cyber access' }, ...[undefined, ...cyberChoices].map((o): MenuItem => ({ label: o ? cyberLabel(o) : 'Default', checked: turn.cyber === o, onSelect: () => turn.cyber !== o && turn.onCyber!(o) })));
  }
  if (!items.length) return null;
  const changes = optionsChanges({ style, agent, memory: memory?.value, turn: turn && { ...turn, onCyber: cyberChoices?.length ? turn.onCyber : undefined } });
  // a phone's row stays one line: at the defaults Options is an icon; a change ("No memory") is always in words
  const words = phone && !changes.length ? <Settings2 className="size-4" strokeWidth={1.75} aria-hidden /> : optionsWords(changes);
  // a change from the defaults reads a step brighter than the quiet row, "No memory" among them
  return <ChipMenu label="Options" words={words} spoken={changes.length ? changes.join(', ') : 'all at their defaults'} items={items} width={320} className={changes.length ? 'text-fg' : undefined} onClose={() => setFold(undefined)} />;
}

/** A session's memory setting from its chat switches (core session/chat.ts). */
export const memoryModeOf = (chat: { memory?: boolean; memorySave?: boolean } | undefined): MemoryMode => (chat?.memory === false ? 'off' : chat?.memorySave === false ? 'use' : 'save');

/** The chat patch for a session that exists: Use and save sends memorySave true, which session/chat.ts clears. */
export const memoryPatch = (m: MemoryMode) => ({ memory: m !== 'off', memorySave: m !== 'use' });

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** A file in the composer, as the strip shows it. */
export interface StripFile {
  name?: string;
  size: number;
  mediaType?: string;
  /** A data URL for a picture's thumbnail. */
  preview?: string;
}

/**
 * The files over the field: one row of chips, left to right, that scrolls
 * sideways at a fixed height, so the field stays in view with any number of
 * files. A picture is a thumbnail, another file its name and size; each has
 * an x. Once the row scrolls, "7 files" sits at its right.
 */
export function AttachmentStrip({ files, onRemove, phone = false }: { files: StripFile[]; onRemove: (i: number) => void; phone?: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const count = files.length;
  const seen = useRef(count);
  // at the end of the row: a file just added comes into view there, and stays once the count takes its room
  const atEnd = useRef(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (count > seen.current) atEnd.current = true;
    seen.current = count;
    const measure = () => {
      setScrolls(el.scrollWidth > el.clientWidth + 1);
      if (atEnd.current) el.scrollLeft = el.scrollWidth;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atEnd.current) el.scrollLeft = el.scrollWidth;
  }, [scrolls]);
  if (!count) return null;
  return (
    <div data-attachments="" className={cn('flex items-center gap-2', phone ? 'px-3 pt-2.5' : 'px-3 pt-3')}>
      <ul
        ref={list}
        aria-label="Attachments"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
        }}
        className={cn('m-0 flex min-w-0 flex-1 list-none flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', phone ? 'h-[60px]' : 'h-[52px]')}
      >
        {files.map((f, i) => (
          <li key={i} className="relative flex shrink-0 items-center">
            {f.preview ? (
              <img src={f.preview} alt={f.name ?? 'Picture'} className={cn('shrink-0 rounded-[var(--r-2)] border border-rule object-cover', phone ? 'size-12' : 'size-11')} />
            ) : (
              <span className={cn('flex max-w-[200px] items-center gap-2 rounded-[var(--r-2)] border border-rule bg-raise pr-8 pl-2.5', phone ? 'h-12 text-[14px]' : 'h-11 text-[13px]')}>
                {isZip(f.mediaType, f.name) ? <FileArchive aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-3" /> : <FileText aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-3" />}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-fg-2">{f.name ?? 'File'}</span>
                  <span className="num text-[11.5px] text-fg-3">{bytes(f.size)}</span>
                </span>
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove ${f.name ?? 'the file'}`}
              onClick={() => onRemove(i)}
              className={cn(
                'absolute grid size-5 place-items-center rounded-full border border-rule bg-raise text-fg-3 transition-colors duration-[var(--dur-1)] hov:text-fg after:absolute after:-inset-2',
                f.preview ? 'top-0.5 right-0.5' : 'top-1/2 right-1.5 -translate-y-1/2',
              )}
            >
              <X aria-hidden strokeWidth={2} className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      {scrolls && <span className={cn('num shrink-0 text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>{filesWord(count)}</span>}
    </div>
  );
}

/**
 * Files picked, dropped or pasted, of any type and any number, read for
 * sending: each at most `maxBytes`, and together what the hub reads in one
 * message.
 */
export async function readPicked(current: Array<{ size: number }>, picked: File[], maxBytes: number): Promise<Array<StripFile & { mediaType: string; data: string; name: string }>> {
  // a picture no model reads (HEIC, AVIF, BMP, TIFF) goes as PNG; one the page cannot draw is refused here, as the hub would
  const pictures = await Promise.all(picked.map(async (was) => ({ was, f: await asPng(was), type: await pictureType(was) })));
  const readable = pictures.filter(({ was, f, type }) => {
    if (f !== was || !type || isModelImage(type) || type === 'image/svg+xml') return true;
    toast({ title: unreadablePicture(was.name, type), level: 'error' });
    return false;
  });
  const small = readable.map(({ f }) => f).filter((f) => {
    if (f.size <= maxBytes) return true;
    toast({ title: `${f.name} is over ${Math.round(maxBytes / 1024 / 1024)} MB. Attach a smaller file.`, level: 'error' });
    return false;
  });
  const { take, refused } = takeFiles(current, small);
  // a plain line, not a failure: the files that fit are attached
  if (refused) toast({ title: refused, level: 'info' });
  const out: Array<StripFile & { mediaType: string; data: string; name: string }> = [];
  for (const f of take) {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    }).catch(() => '');
    if (!dataUrl) {
      toast({ title: `Could not read ${f.name}. Try attaching it again.`, level: 'error' });
      continue;
    }
    // some systems give a zip or a .md no type: the hub knows them by it
    const mediaType = mediaTypeFor(f.type, f.name);
    out.push({ mediaType, data: dataUrl.split(',')[1], name: f.name, size: f.size, preview: mediaType.startsWith('image/') ? dataUrl : undefined });
  }
  return out;
}

/** A picked file sent to the hub on its own (POST /api/uploads); the message names it by uploadId. */
export type UploadedPick = StripFile & { uploadId: string; mediaType: string; name: string };

/**
 * Files picked, dropped or pasted, of any type and any number, each uploaded
 * to the hub on its own (core attachments/uploads.ts), so no count or total
 * cap applies; the hub refuses one past its per-file cap. The hub decides
 * what the model gets inline and what it saves (core attachments/budget.ts).
 */
export async function uploadPicked(picked: File[]): Promise<UploadedPick[]> {
  const pictures = await Promise.all(picked.map(async (was) => ({ was, f: await asPng(was), type: await pictureType(was) })));
  const out: UploadedPick[] = [];
  for (const { was, f, type } of pictures) {
    if (f === was && type && !isModelImage(type) && type !== 'image/svg+xml') {
      toast({ title: unreadablePicture(was.name, type), level: 'error' });
      continue;
    }
    if (f.size > UPLOAD_MAX_BYTES) {
      toast({ title: `${f.name} is over ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB. Attach a smaller file.`, level: 'error' });
      continue;
    }
    const mediaType = mediaTypeFor(f.type, f.name);
    try {
      const up = await api().upload(f, f.name, mediaType);
      out.push({ uploadId: up.id, mediaType, name: f.name, size: f.size, preview: mediaType.startsWith('image/') ? URL.createObjectURL(f) : undefined });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : `Could not upload ${f.name}. Try attaching it again.`, level: 'error' });
    }
  }
  return out;
}

/**
 * uploadPicked for the box of chat `id`. An upload can outlast a chat switch
 * (a big file, a paste the desktop app reads): when `shown` moved on
 * meanwhile, nothing comes back, so the file never lands in another chat's draft.
 */
export async function readPickedFor(id: string, shown: { current: string }, picked: File[]): Promise<UploadedPick[]> {
  const out = await uploadPicked(picked);
  return shown.current === id ? out : [];
}
