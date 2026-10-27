/**
 * The composer (spec 11.2.3), shaped like Claude Code's
 * (conversation/ComposerParts.tsx): one box with "+" at the left, the
 * field, the mic and Send, or Steer and Queue while a turn runs. Under it
 * one quiet row: the permission mode, Code's folder (always open to change)
 * and its device when it is not this computer at the left; the model with
 * its effort (the levels the model has; unset runs at the agent's) and the
 * context ring at the right. "+" holds the agent (custom agents only), the
 * device, the mode (jury, debate, loop...) and Ultra.
 * "/" opens the menu of slash.ts, as in Claude Code: Commands, Skills (run
 * through the Skill tool as /<name> args) and Custom. Settings commands
 * (/mcp, /context, /hooks, ...) open a sheet over the session
 * (sheets/SessionSheets.tsx). "@" opens files from the session's device.
 *
 * Phones (the iPhone app, docs/design/MOBILE-V2.md 4): the box of
 * conversation/PhoneBox.tsx. +, the options sheet (agent, device and
 * folder, permissions, Ultra, mode), the model's short name with its effort
 * (the same picker), the mic and Send, which folds into Stop.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { Session, SessionMode } from '@conclave/core/types';
import { ACCEPT_FILES, MAX_ATTACHMENTS } from '@conclave/core/attachments/limits';
import type { EffortSetting } from '@/lib/effort';
import type { Attachment } from '@conclave/core/client';
import { api } from '@/lib/api';
import { askBtw, attempt, sendQueued, toast, upsertSession, useHub } from '@/store/store';
import { BtwCards } from './Pending';
import { CommentTray } from './CommentTray';
import { openNewChat, openPalette } from '@/store/ui';
import { cn, fuzzyFilter } from '@/lib/text';
import { bytes, hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Kbd, MOD } from '@/components/ui/Kbd';
import { Tooltip } from '@/components/ui/Tooltip';
import { Rim, SendStopButton, type RimState } from '@/components/motion';
import { Sheet, type MenuItem } from '@/components/ui/Overlay';
import { canDictate, DictateButton } from '@/features/conversation/Dictate';
import { AddButton, fitField, OptionsButton, PHONE_FIELD, PhoneBox, PhoneSend } from '@/features/conversation/PhoneBox';
import { AgentPicker, DEFAULT_DEBATE, DEFAULT_JURY, DEFAULT_LOOP, DebatersPicker, DeviceFolderPicker, JudgePicker, JurorsPicker, LoopPicker, ModePicker, PermissionPicker } from './pickers';
import { moveSessionTo } from './FolderChooser';
import { MODES } from './modes';
import { ULTRA_LINE, UltraSwitch } from '../workflows/UltraSwitch';
import { AttachmentStrip, ContextRing, ModelEffort, PhoneModelEffort, PlusMenu, QuietRow, readPicked, useAgentFollow, type StripFile } from '@/features/conversation/ComposerParts';
import { DeviceChip, FolderChip, deviceItems, useComputers } from '@/features/home/Where';
import { useThisComputer } from '@/features/home/here';
import { CODE_AGENT, customAgent, modeOf } from '@/features/home/start';
import { downloadExport, isReminder } from './util';
import { sessionRepo } from '@/lib/github';
import { findSlash, INIT_PROMPT, menuList, PHONE_TOP_COMMANDS, pickAction, SECTION_WORDS, slashItems, slashMode, type SheetId, type SlashItem } from './slash';
import { SessionSheets } from './sheets/SessionSheets';
import { useDraft } from './useDraft';

type FileEntry = { name: string; path: string; type: 'dir' | 'file'; size?: number };

const drafts = new Map<string, string>();
/** Pictures, PDFs, text and code, and zips: in a session the hub saves a zip in its folder (core attachments/zip.ts). */
const ACCEPT = ACCEPT_FILES;
/** One file; 15 in a message at most (core attachments/limits.ts). */
const MAX_BYTES = 12 * 1024 * 1024;

/** Phones: the session menu asks the composer to open its sheet of pickers (agent, model, device, mode). */
export const SESSION_SETTINGS_EVENT = 'conclave:session-settings';

export function Composer({ session }: { session: Session }) {
  const commands = useHub((s) => s.commands);
  const skills = useHub((s) => s.skills);
  const agentDef = useHub((s) => s.agents.find((a) => a.name === session.agent));
  const devices = useHub((s) => s.devices);
  const messages = useHub((s) => s.messages[session.id]);
  const [text, setText] = useState(() => drafts.get(session.id) ?? '');
  const [files, setFiles] = useState<Array<Attachment & StripFile>>([]);
  // what is attached now, for a pick that lands while another is still being read
  const filesNow = useRef(files);
  filesNow.current = files;
  const [sel, setSel] = useState(0);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState<false | 'send' | 'queue' | 'steer'>(false);
  const [sheet, setSheet] = useState(false);
  /** The "/" menu's sheet over the session (/mcp, /context, ...). */
  const [panel, setPanel] = useState<SheetId | null>(null);
  const [caret, setCaret] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [, navigate] = useLocation();
  const mobile = useIsMobile();
  const running = session.status === 'running';
  const waitingOnYou = session.status === 'waiting_approval' || session.status === 'waiting_input';
  const waitingReset = session.status === 'waiting_reset';
  const empty = !messages?.length;
  const agents = useHub((s) => s.agents);
  const here = useThisComputer();
  const computers = useComputers();
  const code = session.kind !== 'chat' && modeOf(session) === 'code';
  // with no Effort of its own a session runs at its agent's level (a coding agent's medium), so the row says what runs
  const follow = useAgentFollow(session.agent, session.model, code);

  useEffect(() => {
    setText(drafts.get(session.id) ?? '');
    setFiles([]);
  }, [session.id]);
  useEffect(() => {
    drafts.set(session.id, text);
  }, [text, session.id]);
  // the stored draft (text and files) comes back after a reload
  useDraft(session.id, text, files, (d) => {
    setText((t) => t || d.text);
    setFiles((f) => (f.length ? f : d.files));
  });

  useEffect(() => {
    const open = () => setSheet(true);
    window.addEventListener(SESSION_SETTINGS_EVENT, open);
    return () => window.removeEventListener(SESSION_SETTINGS_EVENT, open);
  }, []);

  useEffect(() => {
    const onCompose = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'string' && detail) setText(detail);
      requestAnimationFrame(() => box.current?.focus());
    };
    window.addEventListener('conclave:compose', onCompose);
    return () => window.removeEventListener('conclave:compose', onCompose);
  }, []);

  // grow to 12 lines (6 on phones), then scroll
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (mobile) return fitField(el);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = '0px';
    const max = lh * 12 + 8;
    el.style.height = `${Math.max(lh * (mobile ? 1 : 2) + 8, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text, mobile]);

  const patch = async (p: Parameters<ReturnType<typeof api>['updateSession']>[1]) => {
    const s = await attempt(() => api().updateSession(session.id, p));
    if (s) upsertSession(s);
  };
  // unset goes back to the agent's level
  const pickEffort = (v: EffortSetting | undefined) => void patch({ chat: { thinking: v ?? null } });

  const switchModel = async (model: string) => {
    if (model === session.model) return;
    if (messages?.length) {
      const s = await attempt(() => api().handoff(session.id, model), `Switched to ${modelName(model)}.`);
      if (s) upsertSession(s);
    } else void patch({ model });
  };

  const setMode = (mode: SessionMode) => {
    const cfg = session.modeConfig ?? {};
    void patch({
      mode,
      modeConfig: {
        ...cfg,
        ...(mode === 'jury' && !cfg.jury ? { jury: DEFAULT_JURY } : {}),
        ...(mode === 'debate' && !cfg.debate ? { debate: DEFAULT_DEBATE } : {}),
        ...(mode === 'loop' && !cfg.loop ? { loop: DEFAULT_LOOP } : {}),
      },
    });
  };

  const mode = slashMode(session);
  const items: SlashItem[] = useMemo(() => slashItems({ mode, skills, commands, agent: agentDef }), [mode, skills, commands, agentDef]);

  /** A built-in command of the "/" menu (slash.ts), with what followed its name. */
  const runBuiltin = async (name: string, a: string): Promise<unknown> => {
    switch (name) {
      case 'agents':
        return a ? patch({ agent: a }) : setPanel('agents');
      case 'model':
        return a ? switchModel(a) : setPanel('model');
      case 'mode':
        return MODES.some((m) => m.value === a) ? setMode(a as SessionMode) : openPalette('mode');
      case 'jury':
      case 'debate':
        setMode(name);
        if (a) await send(a);
        return;
      case 'review':
        return attempt(() => api().secondOpinion(session.id, { reviewer: a || undefined, includeDiff: true }), 'Asked for a second opinion.');
      case 'handoff':
        return a ? switchModel(a) : setPanel('model');
      case 'device': {
        const d = Object.values(devices).find((x) => x.id === a || x.name === a);
        // a move finds the project's folder on that device (FolderChooser.tsx)
        if (d) return void moveSessionTo(session, d.id);
        document.querySelector<HTMLButtonElement>('[data-picker="device"]')?.click();
        return;
      }
      case 'move':
        // /move hub --copy: Move to hub (core projects/hubcopy.ts); progress shows in the session
        if (/^hub\b/.test(a) && /(^|\s)--copy\b/.test(a)) return attempt(() => api().moveToHub(session.id), 'Copying the folder to the hub.');
        return toast({ title: '/move hub --copy', body: 'Copies this folder to the hub and runs there. /device moves without copying.', level: 'info' });
      case 'cwd':
        return a ? patch({ cwd: a }) : document.querySelector<HTMLButtonElement>('[data-picker="device"]')?.click();
      case 'new':
        return openNewChat({ agent: session.agent, model: session.model, device: session.device });
      case 'fork': {
        const s = await attempt(() => api().forkSession(session.id));
        if (s) {
          upsertSession(s);
          navigate(`/s/${s.id}`);
        }
        return;
      }
      case 'rewind': {
        const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && !isReminder(b)));
        if (!lastUser) return;
        const s = await attempt(() => api().rewind(session.id, lastUser.seq - 1));
        if (s) upsertSession(s);
        return;
      }
      case 'compact': {
        const r = await attempt(() => api().compact(session.id, a || undefined));
        if (r) toast({ title: r.compacted === false ? 'Nothing to compact yet.' : 'Compacted older messages.', level: 'info' });
        return;
      }
      case 'export':
        return downloadExport(session, a === 'json' ? 'json' : 'md');
      case 'clear': {
        // like Claude Code's /clear: a fresh conversation; this one stays in the list for /resume
        const s = await attempt(() => api().createSession({ agent: session.agent, model: session.model, device: session.device, cwd: session.cwd, mode: session.mode, permissionMode: session.permissionMode, modeConfig: session.modeConfig }));
        if (s) {
          upsertSession(s);
          navigate(`/s/${s.id}`);
        }
        return;
      }
      case 'init':
        return send(INIT_PROMPT);
      case 'btw':
        // a side question: never the turn or the queue (Pending.tsx BtwCards shows the answer)
        return a ? askBtw(session.id, a) : setText('/btw ');
      default: {
        const it = findSlash(items, name);
        if (it?.sheet) setPanel(it.sheet);
      }
    }
  };

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  // a bare "/" lists the top commands and a row for the rest, so skills show without scrolling
  const [allCommands, setAllCommands] = useState(false);
  useEffect(() => {
    if (slashQuery === undefined) setAllCommands(false);
  }, [slashQuery]);
  const slashItemsShown = slashQuery !== undefined ? menuList(items, slashQuery, allCommands, mobile ? PHONE_TOP_COMMANDS : undefined) : [];

  // @ files: the token before the caret
  const at = caret < 0 ? null : /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  const atQuery = slashItemsShown.length ? undefined : at?.[2];
  const fileItems = useFileMatches(session, atQuery);
  const menu: 'slash' | 'files' | null = slashItemsShown.length ? 'slash' : atQuery !== undefined && fileItems.length ? 'files' : null;
  const count = menu === 'slash' ? slashItemsShown.length : menu === 'files' ? fileItems.length : 0;
  useEffect(() => setSel(0), [slashQuery, atQuery]);

  async function send(raw: string, whenBusy?: 'queue' | 'steer') {
    const value = raw.trim();
    if (!value && !files.length) return;
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(value);
    if (m && !files.length) {
      const cmd = findSlash(items, m[1]);
      if (cmd) {
        setText('');
        if (cmd.section === 'commands') await runBuiltin(cmd.name, m[2].trim());
        else {
          // a skill (the hub runs it through the Skill tool) or a custom command
          const r = await attempt(() => api().command(session.id, value));
          if (r?.output) toast({ title: `/${cmd.name}`, body: r.output, level: 'info' });
        }
        return;
      }
    }
    const busy = running ? (whenBusy ?? 'queue') : waitingReset || waitingOnYou ? 'queue' : undefined;
    setSending(busy ?? 'send');
    const sent = files;
    const attachments = sent.map(({ size: _s, preview: _p, ...a }) => a);
    // the box clears in the same frame as the press; if the hub refuses, the text comes back
    setText('');
    setFiles([]);
    const input = { text: value, attachments: attachments.length ? attachments : undefined };
    // while a turn runs (or waits on you) the message shows at once in the log, Queued, until its turn takes it (Pending.tsx)
    const r = busy && (running || waitingOnYou) ? await sendQueued(session.id, { ...input, whenBusy: busy }) : await attempt(() => api().send(session.id, { ...input, whenBusy: busy }));
    setSending(false);
    if (r) {
      if (waitingReset && session.resumeAt) toast({ title: `Queued for ${hhmm(session.resumeAt)}.`, level: 'info' });
    } else {
      setText((now) => now || raw);
      setFiles((now) => (now.length ? now : sent));
    }
    box.current?.focus({ preventScroll: true });
  }

  const insertFile = (f: FileEntry) => {
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const rel = relPath(f.path, session.cwd) + (f.type === 'dir' ? '/' : ' ');
    const next = before.replace(/@([^\s@]*)$/, `@${rel}`);
    setText(next + after);
    const pos = next.length;
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  /** Pick a "/" item: open its sheet, wait for its arguments, or run it. */
  const pickSlash = (it: SlashItem) => {
    const how = pickAction(it);
    if (how === 'more') setAllCommands(true);
    else if (how === 'sheet') {
      setText('');
      setPanel(it.sheet!);
    } else if (how === 'fill') setText(`/${it.name} `);
    else void send(`/${it.name}`);
  };

  const pick = (i: number) => {
    if (menu === 'slash') {
      const s = slashItemsShown[i];
      if (!s) return;
      pickSlash(s);
      if (pickAction(s) === 'sheet') return;
    } else if (menu === 'files') {
      const f = fileItems[i];
      if (f) insertFile(f);
    }
    box.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        if (menu === 'slash' && e.key === 'Tab') {
          const s = slashItemsShown[sel];
          if (s?.more) setAllCommands(true);
          else if (s) setText(`/${s.name} `);
        } else pick(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (menu === 'slash') setText('');
        else setCaret(-1);
        return;
      }
    }
    if (e.key === 'Escape' && (running || waitingOnYou)) {
      e.preventDefault();
      void attempt(() => api().abort(session.id));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (mobile && !(e.metaKey || e.ctrlKey)) return; // phones: Enter is a new line
      e.preventDefault();
      void send(text, (e.metaKey || e.ctrlKey) && running ? 'steer' : 'queue');
    }
  };

  // 15 at most: the rest is refused with "Up to 15 files per message. Zip the rest."
  const addFiles = async (list: FileList | File[]) => {
    const out = await readPicked(filesNow.current, Array.from(list), MAX_BYTES);
    if (out.length) setFiles((x) => [...x, ...out].slice(0, MAX_ATTACHMENTS));
  };

  const placeholder = running ? 'Reply, or steer the running turn' : waitingOnYou ? 'Reply. It is sent after you answer above' : waitingReset && session.resumeAt ? `Reply. Sent when it resumes at ${hhmm(session.resumeAt)}` : 'Type / for commands';
  const phonePlaceholder = running ? 'Reply or steer' : waitingOnYou ? 'Reply, sent after you answer' : waitingReset && session.resumeAt ? `Reply, sent at ${hhmm(session.resumeAt)}` : empty ? 'What should it do?' : 'Reply';
  const hasText = !!text.trim() || files.length > 0;
  // with the box empty while a turn runs or waits on you, Send has folded into Stop (spec 1.4)
  const stopping = (running || waitingOnYou) && !hasText;
  // one light on the edge says what the turn is doing (spec 1.3)
  const rim: RimState = running || sending === 'send' ? 'live' : waitingOnYou ? 'waiting' : session.status === 'error' ? 'failed' : waitingReset ? 'idle' : 'done';

  const menuBox = menu && (
        <div
          role="listbox"
          aria-label={menu === 'slash' ? 'Commands' : 'Files'}
          className={cn('absolute inset-x-8 bottom-[calc(100%+4px)] z-30 overflow-y-auto rounded-[var(--r-2)] border border-rule-2 bg-raise p-1 anim-pop phone:inset-x-3', menu === 'slash' ? 'max-h-[min(440px,52vh)] phone:max-h-[48dvh]' : 'max-h-72')}
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          {menu === 'slash'
            ? slashItemsShown.map((s, i) => (
                <div key={`${s.section}:${s.name}`} role="presentation">
                  {(i === 0 || slashItemsShown[i - 1].section !== s.section) && (
                    <div role="presentation" className={cn('px-2 pb-1 text-[12px] font-medium text-fg-3 phone:text-[13px]', i === 0 ? 'pt-1' : 'mt-1 border-t border-rule pt-2')}>
                      {SECTION_WORDS[s.section]}
                    </div>
                  )}
                  <MenuRow on={i === sel} onHover={() => setSel(i)} onPick={() => pick(i)}>
                    {s.more ? (
                      <>
                        <span className="shrink-0 text-fg-2">Show {s.more} more commands</span>
                        {s.description && <span className="mono min-w-0 flex-1 truncate text-fg-3">{s.description}</span>}
                      </>
                    ) : (
                      <>
                        <span className="mono shrink-0 text-fg">/{s.name}</span>
                        {s.arg && <span className="mono shrink-0 text-fg-3 phone:hidden">{s.arg}</span>}
                        <span className="min-w-0 flex-1 truncate text-fg-3">{s.description}</span>
                        {s.source && <span className="max-w-[30%] shrink-0 truncate text-[12px] text-fg-3 phone:hidden">{s.source}</span>}
                      </>
                    )}
                  </MenuRow>
                </div>
              ))
            : fileItems.map((f, i) => (
                <MenuRow key={f.path} on={i === sel} onHover={() => setSel(i)} onPick={() => pick(i)}>
                  <span className="mono min-w-0 flex-1 truncate text-fg">
                    {relPath(f.path, session.cwd)}
                    {f.type === 'dir' ? '/' : ''}
                  </span>
                  {f.type === 'file' && f.size !== undefined && <span className="num shrink-0 text-[12px] text-fg-3">{bytes(f.size)}</span>}
                </MenuRow>
              ))}
          <div className="sticky -bottom-1 mt-1 -mb-1 flex gap-4 phone:hidden border-t border-rule bg-raise px-2 pt-1.5 pb-2 text-[12px] text-fg-3">
            <span>
              <b className="font-medium text-fg-2">↵</b> {menu === 'slash' ? 'run' : 'insert'}
            </span>
            {menu === 'slash' && (
              <span>
                <b className="font-medium text-fg-2">tab</b> complete
              </span>
            )}
            <span>
              <b className="font-medium text-fg-2">esc</b> close
            </span>
          </div>
        </div>
      );
  const sheets = (
    <SessionSheets
      session={session}
      sheet={panel}
      onClose={() => setPanel(null)}
      onOpen={setPanel}
      items={items}
      onPick={(it) => {
        if (pickAction(it) !== 'sheet') setPanel(null);
        pickSlash(it);
        if (pickAction(it) === 'fill') requestAnimationFrame(() => box.current?.focus());
      }}
    />
  );
  const sendStop = (
    <SendStopButton
      running={stopping}
      ready={hasText}
      size={16}
      sendLabel={running || waitingOnYou || waitingReset ? 'Queue' : 'Send'}
      aria-disabled={(!stopping && !hasText) || !!sending ? true : undefined}
      onMouseDown={(e) => {
        if (document.activeElement === box.current) e.preventDefault();
      }}
      onClick={() => {
        if (stopping) void attempt(() => api().abort(session.id));
        else if (hasText && !sending) void send(text);
      }}
      className="size-[30px]"
    />
  );
  if (mobile)
    return (
      <div
        className="relative px-3 pt-1 pb-2"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
      >
        {menuBox}
        <BtwCards sessionId={session.id} />
        <CommentTray session={session} />
        <PhoneBox
          rim={rim}
          attachments={<AttachmentStrip phone files={files} onRemove={(i) => setFiles((x) => x.filter((_, k) => k !== i))} />}
          field={
            <textarea
              ref={box}
              data-composer
              rows={1}
              value={text}
              aria-label="Message"
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
              }}
              onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={onKey}
              onBlur={() => setTimeout(() => setCaret(-1), 150)}
              onFocus={(e) => setCaret(e.target.selectionStart)}
              onPaste={(e) => {
                const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
                if (imgs.length) {
                  e.preventDefault();
                  void addFiles(imgs);
                }
              }}
              placeholder={phonePlaceholder}
              className={PHONE_FIELD}
            />
          }
          add={<AddButton onFiles={(list) => void addFiles(list)} accept={ACCEPT} />}
          options={<OptionsButton label="Options: agent, device and permissions" onClick={() => setSheet(true)} />}
          model={<PhoneModelEffort model={session.model} value={session.chat?.thinking} follow={follow} onModel={(m) => void switchModel(m)} onEffort={pickEffort} cyber={session.chat?.cyber} onCyber={(v) => void patch({ chat: { cyber: v ?? null } })} harnesses switchOf={messages?.length ? session : undefined} />}
          mic={canDictate() && <DictateButton onText={(t) => setText((x) => (x.trim() ? `${x.trimEnd()} ${t}` : t))} />}
          send={
            <PhoneSend
              running={running || waitingOnYou}
              ready={hasText}
              label={running || waitingOnYou || waitingReset ? 'Queue' : 'Send'}
              onSend={() => {
                if (hasText && !sending) void send(text);
              }}
              onStop={() => void attempt(() => api().abort(session.id))}
              keepFocus={() => document.activeElement === box.current}
            />
          }
        />
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Options">
          <div className="space-y-4 px-4 pb-4">
            {empty && <Segmented size="touch" full label="Mode" value={session.mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />}
            <ComposerPickers session={session} patch={patch} switchModel={switchModel} setMode={setMode} look="field" />
          </div>
        </Sheet>
        {sheets}
      </div>
    );

  const customs = agents.filter((a) => (a.primary !== false && a.source !== 'builtin' && customAgent(a.name)) || a.name === session.agent).filter((a) => a.name !== CODE_AGENT);
  const plus: MenuItem[] = [
    ...(code && customs.length ? [{ group: true, label: 'Agent' }, { label: `${CODE_AGENT}, the default`, detail: 'Hands work to its subagents itself', checked: session.agent === CODE_AGENT, onSelect: () => void patch({ agent: CODE_AGENT }) }, ...customs.map((a) => ({ label: a.name, detail: a.description, checked: session.agent === a.name, onSelect: () => void patch({ agent: a.name }) }))] : []),
    ...(code && computers.length > 1 ? deviceItems(computers, session.device, (id) => void moveSessionTo(session, id)) : []),
    { group: true, label: 'Mode' },
    ...MODES.map((m) => ({ label: m.label, detail: m.description, checked: session.mode === m.value, onSelect: () => setMode(m.value) })),
    ...(session.kind !== 'chat' && session.mode !== 'chat' ? [{ separator: true, label: '' }, { label: 'Ultra', detail: ULTRA_LINE, checked: !!session.ultra, keep: true, onSelect: () => void patch({ ultra: !session.ultra }) }] : []),
  ];
  const cfg = session.modeConfig ?? {};
  const left = (
    <>
      {session.mode !== 'chat' && <PermissionPicker look="text" value={session.permissionMode} onChange={(permissionMode) => void patch({ permissionMode })} className="h-[24px] text-[12px]" />}
      {session.mode === 'jury' && <JurorsPicker look="text" value={cfg.jury} onChange={(jury) => void patch({ modeConfig: { ...cfg, jury } })} className="h-[24px] text-[12px]" />}
      {session.mode === 'debate' && <DebatersPicker look="text" value={cfg.debate} onChange={(debate) => void patch({ modeConfig: { ...cfg, debate } })} className="h-[24px] text-[12px]" />}
      {session.mode === 'loop' && <LoopPicker look="text" value={cfg.loop} onChange={(loop) => void patch({ modeConfig: { ...cfg, loop } })} className="h-[24px] text-[12px]" />}
      {code && !sessionRepo(session) && <FolderChip device={session.device} cwd={session.cwd} onCwd={(cwd) => void patch({ cwd })} />}
      {code && session.device !== here && computers.length > 1 && <DeviceChip device={session.device} onDevice={(id) => void moveSessionTo(session, id)} />}
    </>
  );

  return (
    <div
      className="relative mx-auto w-full max-w-[924px] px-8 pb-3 phone:px-3 phone:pb-3"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {menuBox}
      {sheets}
      <BtwCards sessionId={session.id} />
      <CommentTray session={session} />

      <div className={cn('relative rounded-[var(--r-2)] border bg-sunk transition-[border-color] duration-[var(--dur-1)] has-[textarea:focus]:border-edge', drag ? 'border-signal' : 'border-rule-2')}>
        <Rim state={rim} />
        <AttachmentStrip files={files} onRemove={(i) => setFiles((x) => x.filter((_, k) => k !== i))} />
        <textarea
            ref={box}
            data-composer
            rows={1}
            value={text}
            aria-label="Message"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={onKey}
            onBlur={() => setTimeout(() => setCaret(-1), 150)}
            onFocus={(e) => setCaret(e.target.selectionStart)}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
              if (imgs.length) {
                e.preventDefault();
                void addFiles(imgs);
              }
            }}
            placeholder={placeholder}
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-[1.5] text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none phone:text-[16px]"
          />
        <div ref={bar} className="flex items-center gap-1 px-2 pb-2">
          <PlusMenu items={plus} accept={ACCEPT} onFiles={(list) => void addFiles(list)} />
          <span className="flex-1" />
          {running && hasText && (
            <Button variant="quiet" busy={sending === 'steer'} onClick={() => send(text, 'steer')} title={`Add this to the running turn now (${MOD}↵)`}>
              Steer
            </Button>
          )}
          {canDictate() && <DictateButton onText={(t) => setText((x) => (x.trim() ? `${x.trimEnd()} ${t}` : t))} className="size-[30px] [&_svg]:size-[18px]" />}
          <Tooltip content={stopping ? <span className="inline-flex items-center gap-1.5">Stop <Kbd>esc</Kbd></span> : running ? 'Send after this turn' : waitingOnYou || waitingReset ? 'Queue' : 'Send'}>
            {sendStop}
          </Tooltip>
        </div>
      </div>

      <QuietRow
        left={left}
        right={
          <>
            <ModelEffort model={session.model} value={session.chat?.thinking} follow={follow} onModel={(m) => void switchModel(m)} onEffort={pickEffort} cyber={session.chat?.cyber} onCyber={(v) => void patch({ chat: { cyber: v ?? null } })} harnesses switchOf={messages?.length ? session : undefined} />
            <ContextRing session={session} />
          </>
        }
      />
    </div>
  );
}

function MenuRow({ on, onHover, onPick, children }: { on: boolean; onHover: () => void; onPick: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [on]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={on}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn('flex min-h-[30px] items-center gap-3 rounded-[var(--r-1)] px-2 text-[13px] phone:min-h-11 phone:text-[15px]', on && 'bg-hover')}
    >
      {children}
    </div>
  );
}

/** The pickers in the composer bar, split by 14px rules. Field look inside the phone sheet. */
function ComposerPickers({
  session,
  patch,
  switchModel,
  setMode,
  look,
  fit = 'full',
}: {
  session: Session;
  patch: (p: Parameters<ReturnType<typeof api>['updateSession']>[1]) => Promise<void>;
  switchModel: (m: string) => Promise<void>;
  setMode: (m: SessionMode) => void;
  look: 'text' | 'field';
  fit?: 'full' | 'compact' | 'tight';
}) {
  const cfg = session.modeConfig ?? {};
  const bare = fit === 'tight';
  const hiddenAgent = useHub((s) => s.agents.find((a) => a.name === session.agent)?.primary === false);
  const items: Array<{ key: string; label: string; node: ReactNode }> = [];
  const device = <DeviceFolderPicker look={look} bare={bare} showCwd={fit === 'full'} device={session.device} cwd={session.cwd} closeOnDevice onDevice={(device) => void moveSessionTo(session, device)} onCwd={(cwd) => patch({ cwd })} />;
  if (session.mode === 'jury') {
    items.push({ key: 'mode', label: 'Mode', node: <ModePicker look={look} bare={bare} value={session.mode} onChange={setMode} /> });
    items.push({ key: 'jurors', label: 'Jurors', node: <JurorsPicker look={look} value={cfg.jury} onChange={(jury) => patch({ modeConfig: { ...cfg, jury } })} /> });
    items.push({ key: 'judge', label: 'Judge', node: <JudgePicker look={look} bare={bare} value={cfg.jury?.judge} fallback={session.model} onChange={(judge) => patch({ modeConfig: { ...cfg, jury: { ...(cfg.jury ?? DEFAULT_JURY), judge } } })} /> });
    items.push({ key: 'device', label: 'Device', node: device });
  } else if (session.mode === 'debate') {
    items.push({ key: 'mode', label: 'Mode', node: <ModePicker look={look} bare={bare} value={session.mode} onChange={setMode} /> });
    items.push({ key: 'debaters', label: 'Debaters', node: <DebatersPicker look={look} value={cfg.debate} onChange={(debate) => patch({ modeConfig: { ...cfg, debate } })} /> });
    items.push({ key: 'judge', label: 'Judge', node: <JudgePicker look={look} bare={bare} value={cfg.debate?.judge} fallback={session.model} onChange={(judge) => patch({ modeConfig: { ...cfg, debate: { ...(cfg.debate ?? DEFAULT_DEBATE), judge } } })} /> });
    items.push({ key: 'device', label: 'Device', node: device });
  } else {
    items.push({ key: 'agent', label: 'Agent', node: <AgentPicker look={look} includeHidden={hiddenAgent} prefix={look === 'text' && !bare ? 'Agent' : undefined} value={session.agent} onChange={(agent) => patch({ agent })} /> });
    if (session.mode === 'loop') items.push({ key: 'loop', label: 'Loop', node: <LoopPicker look={look} value={cfg.loop} onChange={(loop) => patch({ modeConfig: { ...cfg, loop } })} /> });
    items.push({ key: 'device', label: 'Device and folder', node: device });
    if (session.mode !== 'chat') items.push({ key: 'perm', label: 'Permissions', node: <PermissionPicker look={look} value={session.permissionMode} onChange={(permissionMode) => patch({ permissionMode })} /> });
    if (session.mode !== 'chat' && session.kind !== 'chat') items.push({ key: 'ultra', label: 'Ultra', node: <UltraSwitch look={look} session={session} onChange={(ultra) => patch({ ultra })} /> });
    if (look === 'field') items.push({ key: 'mode', label: 'Mode', node: <ModePicker look={look} value={session.mode} onChange={setMode} /> });
  }
  if (look === 'field')
    return (
      <div className="space-y-3">
        {items.map((it) => (
          <div key={it.key}>
            <div className="mb-1 text-[13px] font-medium text-fg-2">{it.label}</div>
            {it.node}
          </div>
        ))}
      </div>
    );
  return (
    <>
      {items.map((it, i) => (
        <span key={it.key} className="flex shrink-0 items-center">
          {i > 0 && <span aria-hidden className="mx-1 h-3.5 w-px bg-rule" />}
          {it.node}
        </span>
      ))}
    </>
  );
}

function relPath(path: string, cwd: string | undefined): string {
  if (cwd && path.startsWith(cwd.replace(/\/$/, '') + '/')) return path.slice(cwd.replace(/\/$/, '').length + 1);
  return path;
}

/** Entries from the session device for an "@" query: "src/au" lists src and filters by "au". */
function useFileMatches(session: Session, query: string | undefined): FileEntry[] {
  const [cache, setCache] = useState<Record<string, FileEntry[]>>({});
  const base = (session.cwd || '~').replace(/\/$/, '');
  const slash = query?.lastIndexOf('/') ?? -1;
  const dir = query === undefined ? undefined : slash >= 0 ? `${base}/${query.slice(0, slash)}` : base;
  const needle = query === undefined ? '' : query.slice(slash + 1);
  // ~ on one device is not ~ on another: a session that moved, or the next session opened here, lists its own
  const key = `${session.device}:${dir}`;
  useEffect(() => {
    if (dir === undefined || cache[key]) return;
    let live = true;
    api()
      .browse(session.device, dir)
      .then((list) => {
        if (live) setCache((c) => ({ ...c, [key]: list as FileEntry[] }));
      })
      .catch(() => {
        if (live) setCache((c) => ({ ...c, [key]: [] }));
      });
    return () => {
      live = false;
    };
  }, [dir, key, session.device, cache]);
  if (dir === undefined) return [];
  const list = [...(cache[key] ?? [])].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return (needle ? fuzzyFilter(list, needle, (f) => f.name) : list).slice(0, 10);
}
