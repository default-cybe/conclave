/**
 * Parts of the composer, shaped like Claude Code's: one box with "+" at the
 * left, the field, the mic and Send; under it one quiet row with the
 * permission mode (and Code's folder) at the left, and at the right the
 * model with its effort as one picker and a small ring for the context used.
 * Everything else sits in the "+" menu or behind "/".
 *
 * Effort offers the levels the hub's model list gives each model
 * (ModelInfo.effort, lib/effort.ts), its default marked; a level the next
 * model lacks becomes the nearest one it has.
 *
 * Attachments sit above the field as one row of chips that scrolls sideways
 * at a fixed height (AttachmentStrip), so the field never leaves the screen
 * however many files there are; 15 at most (core attachments/limits.ts).
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { FileArchive, FileText, Plus, X } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { claudeEffort } from '@conclave/core/providers/effort';
import { cyberLabel, type CyberProgram } from '@conclave/core/providers/access-programs';
import { filesWord, isZip, mediaTypeFor, takeFiles } from '@conclave/core/attachments/limits';
import { toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { bytes, compact, usd } from '@/lib/format';
import { worthLine } from '@/features/usage/value';
import { useIsMobile } from '@/lib/hooks';
import { harnessId, modelName } from '@/lib/models';
import { effortLabel, effortMenu, shownEffort, useModelEffort, type EffortSetting, type ModelEffort as EffortLevels } from '@/lib/effort';
import { MenuList, Popover, type MenuItem } from '@/components/ui/Overlay';
import { Segmented } from '@/components/ui/Field';
import { LimitRow } from '@/components/ui/Meter';
import { windowApplies } from '@conclave/core/accounts/windows';
import type { AccountDto } from '@conclave/core/client';
import { STATE_WORD, markedName, rowWindows, sessionPlan, useAccounts, type PlanReason } from '@/lib/accounts';
import { PickerButton, SelectMenu } from '@/components/ui/Select';
import { ModelList } from '@/components/pickers/ModelPicker';
import { SwitchModelList } from '@/features/chat/SwitchChoice';
import { ModelWord } from './PhoneBox';

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
  /** The Cyber access program (session.chat.cyber); offered only where the model takes one and onCyber is given. Undefined is Default: nothing sent. */
  cyber?: CyberProgram;
  onCyber?: (v: CyberProgram | undefined) => void;
}

/** Cyber access for a ChatGPT plan model (core providers/access-programs.ts): Default sends nothing, else the program. */
export function CyberAccess({ model, value, onChange }: { model: string | undefined; value: CyberProgram | undefined; onChange: (v: CyberProgram | undefined) => void }) {
  const choices = useHub((s) => (model ? s.models.flatMap((g) => g.models).find((m) => m.ref === model)?.cyber : undefined));
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

/** The picker's body: Effort for the model on top (when it has levels), then the model list. */
function ModelEffortBody({ model, value, follow, onModel, onEffort, harnesses = false, onDone, switchOf, cyber, onCyber }: PickerProps & { onDone: () => void }) {
  const e = useModelEffort(model);
  const mobile = useIsMobile();
  const shown = effortShown(value, e, follow);
  const [stepping, setStepping] = useState(false);
  return (
    <>
      {e && !stepping && (
        <div className="shrink-0 space-y-2 border-b border-rule px-3 pt-2 pb-2.5">
          <div className="flex min-h-[20px] items-center justify-between gap-3 text-[12px] phone:text-[13px]">
            <span className="text-fg-3">Effort</span>
            {follow &&
              (value ? (
                <button type="button" className="text-fg-3 underline-offset-2 hov:text-fg hov:underline" onClick={() => onEffort(undefined)}>
                  Use {follow.label}'s
                </button>
              ) : (
                <span className="text-fg-4">As {follow.label} sets</span>
              ))}
          </div>
          <EffortSegments effort={e} value={shown} onChange={(v) => onEffort(v)} size={mobile ? 'touch' : 'sm'} />
        </div>
      )}
      {onCyber && !stepping && <CyberAccess model={model} value={cyber} onChange={onCyber} />}
      {switchOf ? <SwitchModelList session={switchOf} harnesses={harnesses} onDone={onDone} onStep={setStepping} /> : <ModelList value={model} harnesses={harnesses} onChange={onModel} onDone={onDone} />}
    </>
  );
}

/** The model and its effort as one picker, in the quiet row: "Opus 5.5 Medium". */
export function ModelEffort({ className, ...p }: PickerProps & { className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const e = useModelEffort(p.model);
  const words = modelEffortWords(p.model, effortShown(p.value, e, p.follow), e);
  return (
    <>
      <PickerButton ref={ref} look="text" aria-label={`Model and effort, ${words}`} aria-haspopup="dialog" aria-expanded={open} className={cn('h-[24px] text-[12px] phone:text-[13px]', className)} onClick={() => setOpen((o) => !o)}>
        {words}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-end" width={400} maxHeight={520} label="Model and effort" sheetTitle="Model and effort">
        <ModelEffortBody {...p} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/** Phones: the same picker behind the model's name in the box. */
export function PhoneModelEffort(p: PickerProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const e = useModelEffort(p.model);
  return (
    <>
      <ModelWord ref={ref} name={modelEffortWords(p.model, effortShown(p.value, e, p.follow), e)} expanded={open} onClick={() => setOpen(true)} />
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label="Model and effort" sheetTitle="Model and effort">
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
    const free = !!session && (harnessId(session.model) || (info && !info.inputPrice && !info.outputPrice));
    return { used, window, share: window ? Math.min(1, used / window) : 0, tokensIn: st ? st.inputTokens + st.cacheReadTokens : 0, tokensOut: st?.outputTokens ?? 0, cost: `${st?.costUsd ? usd(st.costUsd) : free ? 'plan' : usd(0)}${worthLine(st) ? `, ${worthLine(st)}` : ''}` };
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
  const running = session?.model ?? model;
  const r = 5.25;
  const c = 2 * Math.PI * r;
  const pct = Math.round(u.share * 100);
  const label = u.used ? `Context, ${pct}% used` : 'Context, nothing used yet';
  return (
    <>
      <button ref={ref} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid size-6 shrink-0 place-items-center rounded-full text-fg-3 hov:bg-hover hov:text-fg">
        <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke="var(--rule-2)" strokeWidth="1.5" />
          <circle cx="7" cy="7" r={r} fill="none" stroke={u.share > 0.8 ? 'var(--warn)' : 'currentColor'} strokeWidth="1.5" strokeDasharray={c} strokeDashoffset={c * (1 - u.share)} strokeLinecap="round" />
        </svg>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-end" width={340} maxHeight={520} label="Context" sheetTitle="Context">
        {running && <PlanSection session={session} model={running} />}
        <dl className="m-0 space-y-1.5 p-3 text-[13px] phone:text-[15px]">
          <Row k="Context">{u.window ? `${compact(u.used)} of ${compact(u.window)}${u.used ? `, ${pct}%` : ''}` : u.used ? compact(u.used) : 'Nothing used yet'}</Row>
          {session && (
            <>
              <Row k="Tokens">{`${compact(u.tokensIn)} in, ${compact(u.tokensOut)} out`}</Row>
              <Row k="Cost">{u.cost}</Row>
            </>
          )}
        </dl>
        <div className="border-t border-rule px-3 py-2 text-[12px] phone:text-[13px]">
          <Link href="/usage" className="link" onClick={() => setOpen(false)}>
            Usage
          </Link>
        </div>
      </Popover>
    </>
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

/** "+": attach files first, then what the conversation adds (web and memory, agent, device, folder, Ultra, modes). */
export function PlusMenu({ items, onFiles, accept, label = 'Add files and more' }: { items: MenuItem[]; onFiles: (files: File[]) => void; accept: string; label?: string }) {
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

/** The quiet row under the box: the left side, then the model and the ring at the right. */
export function QuietRow({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div className="mt-1 flex min-h-[26px] items-center gap-2 px-0.5 text-[12px] text-fg-3">
      <div className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden py-1">{left}</div>
      <div className="flex shrink-0 items-center gap-0.5">{right}</div>
    </div>
  );
}

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
 * Files picked, dropped or pasted, read for sending: the first ones that fit
 * the cap of 15 (and what the hub reads in one message), each at most
 * `maxBytes`. Past the cap: "Up to 15 files per message. Zip the rest."
 */
export async function readPicked(current: Array<{ size: number }>, picked: File[], maxBytes: number): Promise<Array<StripFile & { mediaType: string; data: string; name: string }>> {
  const small = picked.filter((f) => {
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
