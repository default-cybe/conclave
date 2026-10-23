/**
 * The approval card (spec 10.15). The only filled card on a page: bg-raise,
 * a rule-2 hairline, no edge stripe; the amber is in the words ("Waiting 2 min").
 * Used on Home, in the Inbox and in the session thread.
 *
 * Approve and close the gap (CHAT-AND-MOTION 1.4): a decision confirms in
 * place first. The pressed button's label swaps to "Allowed once" with a
 * check and an ok rule fades in at the card's left edge; 600ms later the card
 * reports back, the list (GapList) slides it out and closes the gap.
 *
 * Phones (the iPhone app, docs/design/MOBILE-V2.md 5): a permission prompt
 * at the end of the conversation. "Run this command?" or "Edit
 * redirect.ts?", the command or the file in a mono block, the agent's
 * reason under it, then Allow once, Allow for this chat and Deny stacked at
 * full width. Always allow is in the more menu.
 *
 * A subagent's or a workflow agent's request shows in the chat the owner is
 * in (lib/asks.ts): a quiet line above the card says who asks ("Subagent
 * email asks"), and the session answer reads "Allow for this subagent", as
 * it applies to the session that asked. In the Inbox its line reads "from
 * subagent email in <the chat's title>".
 */
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { Check, CircleHelp, GitPullRequest, Globe, MoreHorizontal, Pencil, Plug, SquareTerminal } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import type { ApprovalRequest, ApprovalResponse } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, heldApprovals, removeKey, useHub, useOnPage } from '@/store/store';
import { cn } from '@/lib/text';
import { durationShort, fileName, hhmm } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { harnessId } from '@/lib/models';
import { shortCommand } from '@/lib/toolLine';
import { hrefOf } from '@/lib/recents';
import { askFromInbox, askFromLine, askHome, sessionDoneWord, sessionWord } from '@/lib/asks';
import { Button, IconButton } from '../ui/Button';
import { Command, CodeBlock, Diff } from '../ui/Code';
import { ConfirmDialog, MenuList, Popover, Sheet, type MenuItem } from '../ui/Overlay';
import { MetaLine } from '../ui/List';
import { HarnessName } from '../logo';
import { Swap } from '../motion';

export type Decision = 'once' | 'session' | 'always' | 'deny';

const RESOLVED_WORD: Record<Decision, string> = { once: 'Allowed once', session: 'Allowed for this session', always: 'Always allowed', deny: 'Denied' };

/** What a decision reads once given; the session answer names a subagent's own session "this subagent". */
function resolvedWord(a: ApprovalRequest, d: Decision): string {
  return d === 'session' ? sessionDoneWord(a) : RESOLVED_WORD[d];
}

/** How long the decision shows in place before the card reports back and leaves. */
export const CONFIRM_MS = 600;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** "42 s", "2 min", "1h 5m": how long it has waited, for phones. */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return durationShort(ms);
}

/** "Waiting 42 s", "Waiting 2 min", "Waiting 1h 5m". */
export function waitWords(ms: number): string {
  return `Waiting ${durationWords(ms)}`;
}

/** The question as a sentence, built from the tool (spec 10.15). */
export function approvalQuestion(a: ApprovalRequest, device?: string): { text: string; mono?: string; after?: string } {
  const i = a.input;
  const t = a.tool;
  if (t === 'Bash' || t === 'Shell' || t === 'exec') return { text: `Run this command${device ? ` on ${device}` : ''}?` };
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit') return { text: 'Edit ', mono: str(i.file_path) ?? str(i.path) ?? 'a file', after: '?' };
  if (t === 'WebFetch' || t === 'Fetch') {
    let host = str(i.url) ?? '';
    try {
      host = new URL(host).host;
    } catch {
      /* keep the raw value */
    }
    return { text: `Fetch ${host || 'a page'}?` };
  }
  const mcp = t.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) return { text: `Use ${mcp[1]} ${mcp[2]}?` };
  // a repo session's push or pull request (docs/DESIGN.md 30)
  if (t === 'PullRequest') return { text: i.action === 'open' ? `Open a pull request on ${str(i.repo) ?? 'GitHub'}?` : `Push to ${str(i.repo) ?? 'GitHub'}?` };
  // watches and the browser (features/watches)
  if (t === 'WatchCreate') return { text: `Make the watch ${str(i.name) ? `"${str(i.name)}"` : ''}?`.replace(' ?', '?') };
  if (t === 'browser_navigate') {
    let host = str(i.url) ?? '';
    try {
      host = new URL(host).host;
    } catch {
      /* keep the raw value */
    }
    return { text: `Open ${host || 'a page'} in the browser?` };
  }
  return { text: `Allow ${t}?` };
}

/** What an approval is about, short, for phones: the command, the path, the host or the tool. */
export function approvalSubject(a: ApprovalRequest): { text: string; mono: boolean; verb: string; Icon: ComponentType<{ className?: string; strokeWidth?: number }> } {
  const i = a.input;
  const t = a.tool;
  if (t === 'Bash' || t === 'Shell' || t === 'exec') return { text: str(i.command) ?? a.summary, mono: true, verb: 'Wants to run', Icon: SquareTerminal };
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit') return { text: str(i.file_path) ?? str(i.path) ?? a.summary, mono: true, verb: t === 'Write' ? 'Wants to write' : 'Wants to edit', Icon: Pencil };
  if (t === 'WebFetch' || t === 'Fetch') return { text: str(i.url) ?? a.summary, mono: true, verb: 'Wants to fetch', Icon: Globe };
  const mcp = t.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) return { text: `${mcp[1]} ${mcp[2]}`, mono: true, verb: 'Wants to use', Icon: Plug };
  if (t === 'PullRequest') return { text: a.summary, mono: false, verb: i.action === 'open' ? 'Wants to open a pull request' : 'Wants to push', Icon: GitPullRequest };
  return { text: a.summary || t, mono: false, verb: `Wants to use ${t}`, Icon: CircleHelp };
}

/** The prompt's title on a phone: "Run this command?", "Edit redirect.ts?", "Fetch example.com?". */
export function approvalTitle(a: ApprovalRequest): string {
  const t = a.tool;
  const path = str(a.input.file_path) ?? str(a.input.path);
  if (t === 'Edit' || t === 'MultiEdit' || t === 'NotebookEdit') return path ? `Edit ${fileName(path)}?` : 'Edit a file?';
  if (t === 'Write') return path ? `Write ${fileName(path)}?` : 'Write a file?';
  return approvalQuestion(a).text;
}

/** What it wants, in one line for an Inbox row: "Wants to run git push", "Wants to edit redirect.ts". */
export function approvalLine(a: ApprovalRequest): string {
  const sub = approvalSubject(a);
  const t = a.tool;
  if (t === 'Bash' || t === 'Shell' || t === 'exec') return `${sub.verb} ${shortCommand(sub.text)}`;
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit') return `${sub.verb} ${fileName(sub.text)}`;
  if (t === 'WebFetch' || t === 'Fetch') {
    try {
      return `${sub.verb} ${new URL(sub.text).host}`;
    } catch {
      return `${sub.verb} ${sub.text}`;
    }
  }
  return sub.mono ? `${sub.verb} ${sub.text}` : sub.verb;
}

/**
 * Deciding an approval: the hub hears it, the decision shows in place, and
 * 600ms later `onResolved` fires and the approval leaves the store. Pass a
 * stable onResolved: the timer starts again when it changes.
 */
export function useApprovalDecision(a: ApprovalRequest, onResolved?: (decision: Decision, at: number) => void) {
  // Allow and Deny are on the page: no toast about this approval
  useOnPage(a.id);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [done, setDone] = useState<{ d: Decision; at: number } | null>(null);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      heldApprovals.delete(a.id);
      removeKey('approvals', a.id);
      onResolved?.(done.d, done.at);
    }, CONFIRM_MS);
    return () => clearTimeout(t);
  }, [done, a.id, onResolved]);

  // Leaving the page before the result fades still drops the decided approval.
  const doneRef = useRef(false);
  doneRef.current = !!done;
  useEffect(
    () => () => {
      if (!doneRef.current) return;
      heldApprovals.delete(a.id);
      removeKey('approvals', a.id);
    },
    [a.id],
  );

  const decide = async (d: Decision) => {
    if (busy || done) return;
    setBusy(d);
    heldApprovals.add(a.id);
    const r: ApprovalResponse = d === 'deny' ? { decision: 'deny' } : { decision: 'allow', scope: d, ...(d === 'always' && a.suggestedRule ? { rule: a.suggestedRule } : {}) };
    const ok = await attempt(() => api().resolveApproval(a.id, r));
    setBusy(null);
    if (ok) setDone({ d, at: Date.now() });
    else heldApprovals.delete(a.id);
  };

  return { busy, done, decide };
}

/** A command that wraps between its words, never inside a flag; a very long word may still break. */
function Words({ text }: { text: string }) {
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+|\s+/g) ?? [text];
  return <>{tokens.map((t, i) => (/^\s+$/.test(t) ? ' ' : <span key={i} className={t.length > 28 ? '[overflow-wrap:anywhere]' : 'whitespace-nowrap'}>{t}</span>))}</>;
}

/** A unified diff for Edit and Write inputs. */
function editDiff(a: ApprovalRequest): string | undefined {
  const i = a.input;
  if (str(i.diff)) return i.diff as string;
  const path = str(i.file_path) ?? str(i.path) ?? 'file';
  const oldS = str(i.old_string);
  const newS = str(i.new_string);
  if (oldS !== undefined || newS !== undefined) {
    const o = (oldS ?? '').split('\n');
    const n = (newS ?? '').split('\n');
    return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${o.length} +1,${n.length} @@`, ...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)].join('\n');
  }
  return undefined;
}

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  /** Collapsed to a one line row (only one card per list is expanded). */
  collapsed?: boolean;
  /** Called when a collapsed row is clicked. */
  onExpand?: () => void;
  /** Hide "Open session" (inside the session itself). */
  inSession?: boolean;
  /** The conversation the card shows in: a subagent's or a workflow agent's request there says who asks, above the card. */
  here?: string;
  /** After a decision the card confirms in place; this fires 600ms later, with when it was decided, and the list removes the card. */
  onResolved?: (decision: Decision, at: number) => void;
  className?: string;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const from = props.here ? askFromLine(props.approval, props.here) : undefined;
  if (!from) return <ApprovalCardBody {...props} />;
  return (
    <div data-ask-from="">
      <p className="m-0 mb-1.5 truncate text-[12.5px] leading-[1.4] text-fg-3 anim-fade phone:mb-2 phone:text-[14px]">{from}</p>
      <ApprovalCardBody {...props} />
    </div>
  );
}

function ApprovalCardBody({ approval: a, collapsed, onExpand, inSession, onResolved, className }: ApprovalCardProps) {
  const mobile = useIsMobile();
  const now = useNow(1000);
  const session = useHub((s) => s.sessions[a.sessionId]);
  // a subagent's request is the chat's: the Inbox names that chat and opens it
  const home = useHub((s) => (a.from ? s.sessions[askHome(a)] : undefined));
  const deviceName = useHub((s) => (session?.device ? (s.devices[session.device]?.name ?? session.device) : undefined));
  const task = useHub((s) => (session?.taskId ? s.tasks[session.taskId] : undefined));
  const { busy, done, decide } = useApprovalDecision(a, onResolved);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const q = approvalQuestion(a, deviceName);
  const waiting = waitWords(now - a.createdAt);
  const harness = a.harness ?? (harnessId(session?.model) ? session?.model : undefined);
  const harnessName = harness && <HarnessName harness={harness} size={13} />;
  const meta = <MetaLine parts={a.from ? [askFromInbox(a, home?.title), harnessName] : [task?.title ?? session?.title, session?.agent, harnessName]} />;
  const command = str(a.input.command);
  const diff = !command ? editDiff(a) : undefined;
  const content = !command && !diff && str(a.input.content);
  const reason = str(a.input.description) ?? str(a.input.reason) ?? str(a.input.justification);

  // each decision button carries its confirmation, so the label swaps in place and the button keeps its width
  const word = (d: Decision, label: ReactNode) => (
    <Swap on={done?.d === d} off={<span>{label}</span>}>
      {/* the check marks an allow; a denial and the rule dialog just say what happened, so the buttons stay narrow */}
      <span className={cn('inline-flex items-center gap-1.5', d === 'deny' ? 'text-fg-2' : 'text-ok')}>
        {(d === 'once' || d === 'session') && <Check className="size-3.5" strokeWidth={2} aria-hidden />}
        {resolvedWord(a, d)}
      </span>
    </Swap>
  );
  // the pressed button stays as it is; the others step back
  const off = (d: Decision) => !!done && done.d !== d;

  const question = (
    <>
      {q.text}
      {q.mono && <span className="mono font-medium">{q.mono}</span>}
      {q.after}
    </>
  );

  if (collapsed)
    return (
      <button type="button" onClick={onExpand} className={cn('flex w-full items-start gap-3 py-2.5 text-left hover:bg-hover', className)}>
        <span className="min-w-0 flex-1">
          <span className="t-row block truncate text-fg">{question}</span>
          <span className="mt-0.5 block truncate text-[12px] text-fg-3">{meta}</span>
        </span>
        <span className="num shrink-0 text-[12px] text-warn">{waiting}</span>
      </button>
    );

  if (mobile) return <PhonePrompt a={a} inSession={inSession} busy={busy} done={done} decide={decide} word={word} off={off} className={className} />;

  const onKey = (e: KeyboardEvent) => {
    if (done || e.target !== ref.current || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') void decide('once');
    else if (k === 's') void decide('session');
    else if (k === 'd') void decide('deny');
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Approval: ${q.text}${q.mono ?? ''}${q.after ?? ''}`}
      className={cn('relative overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 pt-3.5 pb-4 outline-offset-2 anim-rise', className)}
    >
      {/* the decision lands: an ok rule at the left edge (fg-3 for a denial) */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5 opacity-0 transition-opacity duration-[var(--dur-2)]', done?.d === 'deny' ? 'bg-fg-3' : 'bg-ok', done && 'opacity-100')} />
      {done && (
        <span className="sr-only" role="status">
          {resolvedWord(a, done.d)}, {hhmm(done.at)}
        </span>
      )}
      <div className="flex items-baseline gap-3">
        <h3 className="min-w-0 flex-1 text-[14px] leading-[1.4] font-semibold text-fg phone:text-[15px]">{question}</h3>
        <span className="num shrink-0 text-[12px] text-warn phone:text-[13px]">{waiting}</span>
      </div>
      {/* inside a session the title, agent and harness are already on screen */}
      {!inSession && <div className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">{meta}</div>}

      <div className="mt-3">
        {command ? (
          <Command command={command} bare />
        ) : diff ? (
          <Diff diff={diff} bare maxLines={8} header={false} />
        ) : content ? (
          <CodeBlock code={content} bare maxLines={8} copy={false} />
        ) : (
          <CodeBlock code={a.summary} bare copy={false} wrap />
        )}
      </div>

      {reason && <p className="mt-2.5 line-clamp-2 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">“{reason}”</p>}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button variant={done?.d === 'once' ? 'outline' : 'solid'} disabled={off('once')} busy={busy === 'once' ? 'Allowing' : false} onClick={() => decide('once')}>
          {word('once', 'Allow once')}
        </Button>
        <Button variant="outline" disabled={off('session')} busy={busy === 'session'} onClick={() => decide('session')}>
          {word('session', sessionWord(a, 'session'))}
        </Button>
        <Button variant="quiet-fault" disabled={off('deny')} busy={busy === 'deny'} onClick={() => decide('deny')}>
          {word('deny', 'Deny')}
        </Button>
        <span className="ml-auto flex items-center gap-1">
          {/* an untrusted session's answer counts once at the hub: no standing rule is offered */}
          {!a.noAlways && (
            <Button variant="quiet" disabled={off('always')} onClick={() => !done && setConfirm(true)}>
              {word('always', 'Always allow…')}
            </Button>
          )}
          {!inSession && (
            <Link href={hrefOf(home ?? session ?? { id: askHome(a) })} className="rounded-[var(--r-1)] px-2 py-1 text-[13px] text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
              Open session
            </Link>
          )}
        </span>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="neutral"
        width={560}
        title="Always allow this?"
        confirm="Always allow"
        busy="Saving"
        onConfirm={() => decide('always')}
      >
        <p>Conclave saves this rule to the hub's permissions and stops asking when a session matches it.</p>
        <CodeBlock code={a.suggestedRule ?? `${a.tool}(*)`} copy={false} className="mt-3" />
        <p className="mt-3 text-[12px] text-fg-3">Remove it later in Settings, Permissions.</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * Phones: the permission prompt at the end of the conversation. The title,
 * what it wants in a mono block (an edit's changes a tap away), the agent's
 * reason in its own words, then the three answers stacked at full width.
 */
function PhonePrompt({
  a,
  inSession,
  busy,
  done,
  decide,
  word,
  off,
  className,
}: {
  a: ApprovalRequest;
  inSession?: boolean;
  busy: Decision | null;
  done: { d: Decision; at: number } | null;
  decide: (d: Decision) => void;
  word: (d: Decision, label: ReactNode) => ReactNode;
  off: (d: Decision) => boolean;
  className?: string;
}) {
  // a subagent's request opens the chat it shows in, and is titled with it
  const session = useHub((s) => s.sessions[askHome(a)] ?? s.sessions[a.sessionId]);
  const [, navigate] = useLocation();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [changes, setChanges] = useState(false);
  const command = str(a.input.command);
  const diff = !command ? editDiff(a) : undefined;
  const subject = approvalSubject(a);
  const reason = str(a.input.description) ?? str(a.input.reason) ?? str(a.input.justification);
  const title = approvalTitle(a);
  const later = (fn: () => void) => () => setTimeout(fn, 0);
  const items: MenuItem[] = a.noAlways ? [] : [{ label: 'Always allow…', detail: 'Save a rule and stop asking', disabled: !!done, onSelect: later(() => setConfirm(true)) }];
  if (!inSession && session) items.push({ label: 'Open the conversation', onSelect: () => navigate(session.kind === 'chat' ? `/chat/${session.id}` : `/s/${session.id}`) });
  return (
    <div id={`ask-${a.id}`} aria-label={`Approval: ${title}`} className={cn('relative rounded-[18px] border border-rule p-4 anim-rise', className)}>
      {done && (
        <span className="sr-only" role="status">
          {resolvedWord(a, done.d)}, {hhmm(done.at)}
        </span>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="m-0 text-[16px] leading-[1.35] font-semibold text-fg">{title}</h3>
          {!inSession && session && <p className="m-0 mt-0.5 truncate text-[14px] text-fg-3">{askFromInbox(a, session.title) ?? session.title}</p>}
        </div>
        {items.length > 0 && (
          <IconButton ref={more} label="More answers" size="touch" className="-mt-2 -mr-2 rounded-full!" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)}>
            <MoreHorizontal />
          </IconButton>
        )}
      </div>
      <p className="m-0 mt-3 rounded-[12px] bg-surface-2 px-3.5 py-3 font-mono text-[14px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{command ? <Words text={command} /> : subject.text}</p>
      {diff && (
        <button type="button" onClick={() => setChanges(true)} className="-mb-1 flex min-h-11 items-center text-[15px] text-fg-2 active:text-fg">
          Show the changes
        </button>
      )}
      {reason && <p className="m-0 mt-3 text-[15px] leading-[1.45] text-pretty text-fg-2">“{reason}”</p>}
      <div className="mt-4 flex flex-col gap-2">
        <Button variant={done?.d === 'once' ? 'outline' : 'solid'} size="touch" full disabled={off('once')} busy={busy === 'once' ? 'Allowing' : false} onClick={() => decide('once')} className="h-12! rounded-[12px]! text-[16px]!">
          {word('once', 'Allow once')}
        </Button>
        <Button variant="outline" size="touch" full disabled={off('session')} busy={busy === 'session' ? 'Allowing' : false} onClick={() => decide('session')} className="h-12! rounded-[12px]! text-[16px]!">
          {word('session', sessionWord(a, 'chat'))}
        </Button>
        <Button variant="outline" size="touch" full disabled={off('deny')} busy={busy === 'deny' ? 'Denying' : false} onClick={() => decide('deny')} className="h-12! rounded-[12px]! text-[16px]!">
          {word('deny', 'Deny')}
        </Button>
      </div>
      <Popover anchor={more} open={menu} onClose={() => setMenu(false)} label="More answers" sheetTitle={title}>
        <MenuList onDone={() => setMenu(false)} label="More answers" items={items} />
      </Popover>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} tone="neutral" title="Always allow this?" confirm="Always allow" busy="Saving" onConfirm={() => decide('always')}>
        <p>Conclave saves this rule to the hub's permissions and stops asking when a session matches it.</p>
        <CodeBlock code={a.suggestedRule ?? `${a.tool}(*)`} copy={false} className="mt-3" />
        <p className="mt-3 text-[13px] text-fg-3">Remove it later in Settings, Permissions.</p>
      </ConfirmDialog>
      {diff && (
        <Sheet open={changes} onClose={() => setChanges(false)} title={fileName(subject.text)}>
          <div className="px-4 pb-4">
            <Diff diff={diff} header={false} />
          </div>
        </Sheet>
      )}
    </div>
  );
}
