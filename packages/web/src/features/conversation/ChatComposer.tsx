/**
 * The chat composer (docs/design/CHAT-AND-MOTION.md 2.5), shaped like
 * Claude Code's (ComposerParts.tsx): one box with the field, "+" at the
 * left (attach, search the web, use memory) and the mic and Send at the
 * right; Send turns into Stop while a reply runs. Under the box one quiet
 * row: the model with its effort (the levels the model has, lib/effort.ts)
 * and the context ring at the right. Picking another model keeps the Effort
 * level when it has it, else the nearest one it has.
 *
 * A new Assistant or Code conversation uses the same box with a `target`
 * (SessionStart.tsx): the quiet row's left side, its own model and effort,
 * more under "+", another place for the message, and slash commands.
 *
 * Phones (docs/design/MOBILE-V2.md 4): the box of PhoneBox.tsx. +, the
 * options sheet (web and memory, or the target's), the model's short name
 * with its effort (the same picker), the mic and Send. The Chat, Assistant
 * and Code switch is in Home's bar.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { Attachment } from '@conclave/core/client';
import type { CyberProgram } from '@conclave/core/providers/access-programs';
import type { Session } from '@conclave/core/types';
import { ACCEPT_FILES, MAX_ATTACHMENTS } from '@conclave/core/attachments/limits';
import { askBtw, useHub } from '@/store/store';
import { BtwCards } from '@/features/chat/Pending';
import { btwQuestion } from '@/features/chat/slash';
import { cn, fuzzyFilter } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { effortForModel, effortOf, type EffortSetting } from '@/lib/effort';
import { Checkbox } from '@/components/ui/Field';
import { Kbd } from '@/components/ui/Kbd';
import { Sheet, type MenuItem } from '@/components/ui/Overlay';
import { Tooltip } from '@/components/ui/Tooltip';
import { Rim, SendStopButton, type RimState } from '@/components/motion';
import { isReminder } from '@/features/chat/util';
import { canDictate, DictateButton } from './Dictate';
import { AttachmentStrip, ContextRing, ModelEffort, PhoneModelEffort, PlusMenu, QuietRow, readPicked, type EffortFollow } from './ComposerParts';
import { AddButton, fitField, OptionsButton, PHONE_FIELD, PhoneBox, PhoneSend } from './PhoneBox';
import { patchChat, sendTo, startChat, stopChat, type Outgoing } from './actions';
import { DEFAULTS_EVENT, readDefaults, saveDefaults, setEditing, setRestore, useChatUi, type Thinking } from './state';

/** One file; 15 in a message at most, and together what the hub reads in one request (core attachments/limits.ts). */
const MAX_BYTES = 20 * 1024 * 1024;
/** Pictures, PDFs, text and code, and zips (the hub unpacks a zip, core attachments/zip.ts). */
const ACCEPT = ACCEPT_FILES;
export const FILES_EVENT = 'conclave:chat-files';
/** A target that held a message to ask something first (Code's device and folder) sends it with this. */
export const SEND_EVENT = 'conclave:chat-send';

interface Switches {
  model?: string;
  webSearch: boolean;
  memory: boolean;
  thinking?: Thinking;
  cyber?: CyberProgram;
}

type FileItem = Attachment & { size: number; preview?: string };

/** A hub command offered while the message is "/" and part of its name. */
export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/**
 * Somewhere else for the message to go than a chat (a new Assistant or Code
 * session). The box, attachments and keys stay the same; the quiet row, the
 * "+" menu and the send change.
 */
export interface ComposerTarget {
  /** The quiet row's left side: the permission mode, Code's folder and device. */
  left?: ReactNode;
  /** The model and its effort, at the right of the quiet row (and in the box on phones). */
  model: string | undefined;
  /** The picker offers the coding agents the owner turned on as engines (Code). */
  harnesses?: boolean;
  /** Unset runs at `follow`'s level (the agent's), else the model's default. */
  effort?: EffortSetting;
  follow?: EffortFollow;
  onModel: (ref: string) => void;
  onEffort: (effort: EffortSetting | undefined) => void;
  /** Cyber access for a ChatGPT plan model (session.chat.cyber at the start); offered where the model takes one. */
  cyber?: CyberProgram;
  onCyber?: (v: CyberProgram | undefined) => void;
  /** "+" after Attach files: agent, device, folder, repository, Ultra. */
  plus?: MenuItem[];
  /** Phones: the options button and its sheet, in place of the chat's. */
  phoneOptions: ReactNode;
  /**
   * Before the box clears: false holds the message here while the target asks
   * for something first. It sends it later with SEND_EVENT.
   */
  prepare?: (out: Outgoing) => boolean;
  /** Send it. False when it did not go: the text and files come back. */
  send: (out: Outgoing) => Promise<boolean>;
  /** The send button's name and tooltip ("Start session"). */
  sendLabel: string;
  placeholder: string;
  /** A quiet line under the box, in place of the memory note. */
  note?: ReactNode;
  /** Offered in a menu while the message is "/" and part of a name. */
  commands?: SlashCommand[];
}

const drafts = new Map<string, string>();
/** Attachments of a send the hub refused, for the composer that took this one's place. */
const fileDrafts = new Map<string, FileItem[]>();
/**
 * You sent from a focused composer. The first send of a new chat swaps the
 * empty page for the chat, which mounts a new composer: it takes the focus
 * back, so the keyboard stays open on phones.
 */
let focusUntil = 0;

const WEB_HELP = 'Look things up and cite sources';
const MEMORY_HELP = 'Read what it knows about you and save what you tell it. Off: this chat leaves no trace in memory.';

/** The switches of a chat, or of the next new chat (the last ones used on this device). */
function useSwitches(session: Session | undefined): [Switches, (p: Partial<Switches>) => void] {
  const hubModel = useHub((s) => s.hub?.defaultModel);
  const [local, setLocal] = useState<Switches>(() => readDefaults());
  useEffect(() => {
    const reread = () => setLocal(readDefaults());
    window.addEventListener(DEFAULTS_EVENT, reread);
    return () => window.removeEventListener(DEFAULTS_EVENT, reread);
  }, []);
  const current: Switches = session
    ? { model: session.model, webSearch: session.chat?.webSearch !== false, memory: session.chat?.memory !== false, thinking: session.chat?.thinking, cyber: session.chat?.cyber }
    : { ...local, model: local.model ?? hubModel };
  const change = (patch: Partial<Switches>) => {
    // another model keeps the Effort level when it has it, else takes the nearest one it has
    let p = patch;
    if (patch.model !== undefined && !('thinking' in patch) && current.thinking) {
      const next = effortForModel(current.thinking, effortOf(useHub.getState().models, patch.model));
      if (next !== current.thinking) p = { ...patch, thinking: next };
    }
    saveDefaults(p);
    if (!session) {
      setLocal((x) => ({ ...x, ...p }));
      return;
    }
    if (p.model !== undefined) void patchChat(session.id, { model: p.model });
    const chat: Record<string, unknown> = {};
    if (p.webSearch !== undefined) chat.webSearch = p.webSearch;
    if (p.memory !== undefined) chat.memory = p.memory;
    if ('thinking' in p) chat.thinking = p.thinking ?? null;
    if ('cyber' in p) chat.cyber = p.cyber ?? null;
    if (Object.keys(chat).length) void patchChat(session.id, { chat });
  };
  return [current, change];
}

/** Whether the model can think: a reply holds a row for its thought. The Effort control reads the model's levels (lib/effort.ts). */
export function useModelThinks(model: string | undefined): boolean {
  return useHub((s) => {
    if (!model) return false;
    for (const g of s.models) for (const m of g.models) if (m.ref === model) return m.thinking;
    return false;
  });
}

export function ChatComposer({
  session,
  chatId,
  autoFocus,
  placeholder: placeholderProp,
  target,
  minRows = 2,
  blurOnEsc,
}: {
  session?: Session;
  chatId: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** A new Assistant or Code session: its own quiet row, "+" items and send. */
  target?: ComposerTarget;
  /** Lines the empty box shows on desktop (phones show one). */
  minRows?: number;
  /** Esc leaves the box, so the page's single keys work again (Home). */
  blurOnEsc?: boolean;
}) {
  const [text, setText] = useState(() => drafts.get(chatId) ?? '');
  const [files, setFiles] = useState<FileItem[]>([]);
  // what is attached now, for a pick that lands while another is still being read
  const filesNow = useRef(files);
  filesNow.current = files;
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [sw, change] = useSwitches(session);
  const restore = useChatUi((s) => s.restore[chatId]);
  // waiting on you (an approval or a question) is still a reply in flight: Stop stays, the Rim breathes amber
  const onYou = session?.status === 'waiting_approval' || session?.status === 'waiting_input';
  const running = session?.status === 'running' || onYou;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setText(drafts.get(chatId) ?? '');
    setFiles([]);
  }, [chatId]);
  useEffect(() => {
    drafts.set(chatId, text);
  }, [text, chatId]);
  // a Stop dropped messages that were queued behind the reply: they come back here to send again
  useEffect(() => {
    if (restore === undefined) return;
    setRestore(chatId, undefined);
    if (restore) setText((t) => (t.trim() ? `${t}\n\n${restore}` : restore));
    const back = fileDrafts.get(chatId);
    if (back) {
      fileDrafts.delete(chatId);
      setFiles((x) => [...x, ...back]);
    }
    box.current?.focus({ preventScroll: true });
  }, [restore, chatId]);
  useEffect(() => {
    if ((autoFocus && !mobile) || Date.now() < focusUntil) box.current?.focus({ preventScroll: true });
  }, [autoFocus, mobile, chatId]);

  // grow to 12 lines (6 on phones), then scroll
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (mobile) return fitField(el);
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 24;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = '0px';
    const content = el.scrollHeight - pad;
    const max = lh * 12;
    el.style.height = `${Math.max(lh * (mobile ? 1 : minRows), Math.min(content, max)) + pad}px`;
    el.style.overflowY = content > max + 1 ? 'auto' : 'hidden';
  }, [text, mobile, minRows]);

  // "/" and part of a name lists the hub's commands (Session mode on Home): arrows, Enter or Tab, Esc
  const listId = useId();
  const query = target?.commands ? /^\/(\S*)$/.exec(text)?.[1] : undefined;
  const commands = useMemo(() => (query !== undefined && target?.commands ? fuzzyFilter(target.commands, query, (c) => c.name).slice(0, 8) : []), [query, target?.commands]);
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const menuOpen = commands.length > 0 && !menuOff;
  useEffect(() => {
    setSel(0);
    setMenuOff(false);
  }, [query]);
  const pickCommand = (i: number) => {
    const c = commands[i];
    if (!c) return;
    setText(`/${c.name} `);
    setMenuOff(true);
    box.current?.focus();
  };

  // 15 at most: the rest is refused with "Up to 15 files per message. Zip the rest."
  const addFiles = async (list: FileList | File[]) => {
    const out = await readPicked(filesNow.current, Array.from(list), MAX_BYTES);
    if (out.length) setFiles((x) => [...x, ...out].slice(0, MAX_ATTACHMENTS));
    box.current?.focus();
  };

  // files dropped anywhere on the chat column
  useEffect(() => {
    const onFiles = (e: Event) => {
      const list = (e as CustomEvent<File[]>).detail;
      if (list?.length) void addFiles(list);
    };
    window.addEventListener(FILES_EVENT, onFiles);
    return () => window.removeEventListener(FILES_EVENT, onFiles);
  });

  const hasText = !!text.trim() || files.length > 0;

  const send = async () => {
    if (!hasText || busy) return;
    const out = { text: text.trim(), attachments: files.map(({ size: _s, preview: _p, ...a }) => a) };
    // /btw: a side question, never the turn or the queue (Pending.tsx BtwCards)
    const btw = !target && session && !files.length ? btwQuestion(out.text) : undefined;
    if (btw && session) {
      setText('');
      return void askBtw(session.id, btw);
    }
    if (target?.prepare && !target.prepare(out)) return;
    // the composer clears in the same frame; a refusal puts the text back
    if (document.activeElement === box.current) focusUntil = Date.now() + 1500;
    setText('');
    setFiles([]);
    drafts.delete(chatId);
    setBusy(true);
    const ok = target
      ? await target.send(out)
      : session
        ? await sendTo(session, out)
        : await startChat(out, { model: sw.model, chat: { webSearch: sw.webSearch, memory: sw.memory, ...(sw.thinking ? { thinking: sw.thinking } : {}), ...(sw.cyber ? { cyber: sw.cyber } : {}) } }, navigate);
    if (!ok) {
      if (alive.current) {
        setText(out.text);
        setFiles(files);
      } else {
        // the first send of a new chat failed after the page swapped composers: the new one gets it back
        if (files.length) fileDrafts.set(chatId, files);
        setRestore(chatId, out.text);
      }
    }
    if (!alive.current) return;
    setBusy(false);
    box.current?.focus({ preventScroll: true });
  };

  const stop = () => {
    if (session) void stopChat(session.id);
  };

  // the target has what it asked for: send what it held
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const on = () => void sendRef.current();
    window.addEventListener(SEND_EVENT, on);
    return () => window.removeEventListener(SEND_EVENT, on);
  }, []);

  const editLast = () => {
    if (!session) return false;
    const list = useHub.getState().messages[session.id] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      // the hub's own notes (output limit, Stop hook feedback) are user messages too, but not yours to edit
      if (m.role === 'user' && m.content.some((b) => b.type === 'text' && !isReminder(b))) {
        setEditing(session.id, m.id);
        return true;
      }
    }
    return false;
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        pickCommand(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOff(true);
        return;
      }
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      stop();
      return;
    }
    if (e.key === 'Escape' && blurOnEsc) {
      e.preventDefault();
      box.current?.blur();
      return;
    }
    if (e.key === 'ArrowUp' && !text && !files.length && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (editLast()) e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (mobile && !(e.metaKey || e.ctrlKey)) return; // phones: Enter is a new line, Send sends
      e.preventDefault();
      void send();
    }
  };

  // one light on the box's edge says what the reply is doing (spec 1.3): it runs while the reply
  // runs (from the moment you send), breathes amber while it waits on you, settles
  // when it ends and stays as a short red mark when it fails
  const status = session?.status;
  // a limit has no light (spec 1.3): the reply's grey stub and its countdown say it
  const rim: RimState = onYou ? 'waiting' : running || busy ? 'live' : status === 'error' ? 'failed' : status === 'waiting_reset' ? 'idle' : session ? 'done' : 'idle';

  const placeholder = placeholderProp ?? target?.placeholder ?? (!session ? 'Ask anything' : running ? 'Reply, it will be sent when this one finishes' : 'Reply');
  const sendLabel = target?.sendLabel ?? 'Send';

  const memoryNote = !target && !sw.memory;
  const notes =
    memoryNote || target?.note ? (
      <div className="mt-2 space-y-0.5 px-0.5 text-[12px] text-fg-3 phone:px-2 phone:text-[13px]">
        {memoryNote && <p>Memory is off for this chat. It will not read or save notes.</p>}
        {target?.note}
      </div>
    ) : null;
  const commandList = menuOpen && (
    <ul
      id={listId}
      role="listbox"
      aria-label="Commands"
      // phones: above the box, so the keyboard does not cover it
      className={cn('absolute left-0 z-30 w-[min(420px,100%)] rounded-[var(--r-2)] border border-rule-2 bg-raise p-1 shadow-[var(--shadow-pop)] anim-pop', mobile ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]')}
    >
      {commands.map((c, i) => (
        <li
          key={c.name}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === sel}
          onMouseMove={() => setSel(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            pickCommand(i);
          }}
          className={cn('flex min-h-[30px] cursor-default items-baseline gap-3 rounded-[var(--r-1)] px-2 py-1.5 text-[13px] phone:min-h-11 phone:items-center phone:text-[15px]', i === sel && 'bg-hover')}
        >
          <span className="mono shrink-0 text-fg">/{c.name}</span>
          {c.argumentHint && <span className="mono shrink-0 text-fg-3">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-fg-3">{c.description}</span>
        </li>
      ))}
    </ul>
  );
  const field = (className: string) => (
    <textarea
      ref={box}
      data-composer
      rows={1}
      value={text}
      aria-label="Message"
      aria-autocomplete={target?.commands ? 'list' : undefined}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={menuOpen ? `${listId}-${sel}` : undefined}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKey}
      onPaste={(e) => {
        const list = Array.from(e.clipboardData.files);
        if (list.length) {
          e.preventDefault();
          void addFiles(list);
        }
      }}
      placeholder={placeholder}
      enterKeyHint={mobile ? 'enter' : 'send'}
      className={className}
    />
  );

  if (mobile)
    return (
      <div className="w-full px-3 pt-1 pb-2">
        <div className="relative">
          {commandList}
          {session && <BtwCards sessionId={session.id} />}
          <PhoneBox
            rim={rim}
            attachments={<AttachmentStrip phone files={files} onRemove={(i) => setFiles((x) => x.filter((_, k) => k !== i))} />}
            field={field(PHONE_FIELD)}
            add={<AddButton onFiles={(list) => void addFiles(list)} accept={ACCEPT} />}
            options={target ? target.phoneOptions : <OptionsButton label="Options: web and memory" onClick={() => setSheet(true)} />}
            model={target ? <PhoneModelEffort model={target.model} value={target.effort} follow={target.follow} onModel={target.onModel} onEffort={target.onEffort} cyber={target.cyber} onCyber={target.onCyber} harnesses={target.harnesses} /> : <PhoneModelEffort model={sw.model} value={sw.thinking} onModel={(m) => change({ model: m })} onEffort={(v) => change({ thinking: v })} cyber={sw.cyber} onCyber={(v) => change({ cyber: v })} />}
            mic={canDictate() && <DictateButton onText={(t) => setText((x) => (x.trim() ? `${x.trimEnd()} ${t}` : t))} />}
            send={<PhoneSend running={running} ready={hasText} label={sendLabel} onSend={send} onStop={stop} keepFocus={() => document.activeElement === box.current} />}
          />
        </div>
        {notes}
        {!target && (
          <Sheet open={sheet} onClose={() => setSheet(false)} title="Options">
            <div className="space-y-5 px-4 pb-5">
              <OptionRow label="Tools">
                <div className="space-y-2">
                  <Checkbox checked={sw.webSearch} onChange={(v) => change({ webSearch: v })} label="Search the web" description={WEB_HELP} />
                  <Checkbox checked={sw.memory} onChange={(v) => change({ memory: v })} label="Use memory" description={MEMORY_HELP} />
                </div>
              </OptionRow>
            </div>
          </Sheet>
        )}
      </div>
    );

  // "+" holds what a chat adds (web, memory) or what the target adds; the quiet row has the model with its effort and the ring
  const plus: MenuItem[] = target
    ? (target.plus ?? [])
    : [
        { label: 'Search the web', detail: WEB_HELP, checked: sw.webSearch, keep: true, onSelect: () => change({ webSearch: !sw.webSearch }) },
        { label: 'Use memory', detail: MEMORY_HELP, checked: sw.memory, keep: true, onSelect: () => change({ memory: !sw.memory }) },
      ];
  const modelEffort = target ? (
    <ModelEffort model={target.model} value={target.effort} follow={target.follow} onModel={target.onModel} onEffort={target.onEffort} cyber={target.cyber} onCyber={target.onCyber} harnesses={target.harnesses} />
  ) : (
    <ModelEffort model={sw.model} value={sw.thinking} onModel={(m) => change({ model: m })} onEffort={(v) => change({ thinking: v })} cyber={sw.cyber} onCyber={(v) => change({ cyber: v })} />
  );

  return (
    <div className="mx-auto w-full max-w-[784px] px-8 pb-3 phone:px-4 phone:pb-3">
      <div className="relative">
        {commandList}
        {session && <BtwCards sessionId={session.id} />}
        <div className="relative rounded-[var(--r-2)] border border-rule-2 bg-sunk transition-[border-color] duration-[var(--dur-1)] has-[textarea:focus-visible]:border-edge">
          <Rim state={rim} />
          <AttachmentStrip files={files} onRemove={(i) => setFiles((x) => x.filter((_, k) => k !== i))} />
          {field('t-chat block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none')}
          <div className="flex items-center gap-1 px-2 pb-2">
            <PlusMenu items={plus} accept={ACCEPT} onFiles={(list) => void addFiles(list)} />
            <span className="flex-1" />
            {canDictate() && <DictateButton onText={(t) => setText((x) => (x.trim() ? `${x.trimEnd()} ${t}` : t))} className="size-[30px] [&_svg]:size-[18px]" />}
            <Tooltip content={running && !hasText ? (<span className="inline-flex items-center gap-1.5">Stop <Kbd>esc</Kbd></span>) : running ? 'Send when this reply ends' : sendLabel}>
              <SendStopButton
                running={running && !hasText}
                ready={hasText}
                size={16}
                sendLabel={sendLabel}
                aria-disabled={!running && !hasText ? true : undefined}
                onMouseDown={(e) => {
                  if (document.activeElement === box.current) e.preventDefault();
                }}
                onClick={running ? (hasText ? send : stop) : send}
                className="size-[30px]"
              />
            </Tooltip>
          </div>
        </div>
      </div>
      <QuietRow
        left={target?.left}
        right={
          <>
            {modelEffort}
            <ContextRing session={session} model={target ? target.model : sw.model} />
          </>
        }
      />
      {notes}
    </div>
  );
}

function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-fg-2">{label}</div>
      {children}
    </div>
  );
}

/** Effort as a menu or segments: ComposerParts.tsx, where the model and effort picker uses them. */
export { EffortMenu, EffortSegments } from './ComposerParts';
