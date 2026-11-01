/**
 * A conversation's sheet on a phone (docs/design/MOBILE-V2.md 5), from its
 * title: who answers and where (agent, model, device, folder), what it cost
 * (tokens, cost) and when it started. Then Stop, Move to main list for
 * delegated work, Rename, Send to friend, Archive and Move to Code or Chat;
 * a session also opens its details (plan, files, context), and Delete is
 * last. The transcript keeps none of these
 * numbers.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { compact, folderName, hhmm, shortDate, usd } from '@/lib/format';
import { worthLine } from '@/features/usage/value';
import { modelName } from '@/lib/models';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConfirmDialog, Dialog, Sheet } from '@/components/ui/Overlay';
import { keepSession, patchChat, stopChat } from '@/features/conversation/actions';
import { openContinue } from '@/features/conversation/state';
import { ContextPanel } from './ContextPanel';
import { SendToFriendAction, SendToFriendDialog } from '@/features/friends/SendToFriend';
import { isChat } from './util';
import { repoFacts, RepoSheetActions, useArchiveRepo } from '@/features/github/RepoBar';
import { sessionRepo } from '@/lib/github';
import { isDelegated } from '@conclave/core/session/delegated';
import { moveToMainList, MOVE_TO_MAIN } from './delegated';

/** "Today, 18:58", "16 Oct, 14:02". */
export function startedWords(ts: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  return `${day(ts) === day(now) ? 'Today' : shortDate(ts)}, ${hhmm(ts)}`;
}

export function ConversationSheet({ session, open, onClose }: { session: Session; open: boolean; onClose: () => void }) {
  const device = useHub((s) => s.devices[session.device]?.name ?? session.device);
  const [, navigate] = useLocation();
  const [renaming, setRenaming] = useState(false);
  const [details, setDetails] = useState(false);
  const [del, setDel] = useState(false);
  const [send, setSend] = useState(false);
  const chat = isChat(session);
  const live = session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input';
  const tokens = session.stats.inputTokens + session.stats.outputTokens;
  // a repo session shows its repository and branch instead of its worktree
  const folder = !chat && !sessionRepo(session) && session.cwd && session.cwd !== '~' ? session.cwd : undefined;
  const later = (fn: () => void) => () => {
    onClose();
    setTimeout(fn, 0);
  };
  const list = chat ? '/chats' : '/sessions';

  const archiveNow = async () => {
    const s = await patchChat(session.id, { archived: !session.archived });
    if (s && s.archived) navigate(list);
  };
  const arch = useArchiveRepo(session, archiveNow);
  const archive = () => {
    onClose();
    if (session.archived) void archiveNow();
    else setTimeout(arch.archive, 0);
  };
  const toChat = async () => {
    onClose();
    const s = await attempt(() => api().updateSession(session.id, { kind: 'chat' }));
    if (!s) return;
    keepSession(s);
    navigate(`/chat/${s.id}`, { replace: true });
  };

  const facts: Array<[string, ReactNode]> = [
    ['Agent', session.agent],
    ['Model', modelName(session.model)],
    ['Device', device],
    ...(folder ? [['Folder', <span className="font-mono text-[14px]" title={folder}>{folderName(folder) || folder}</span>] as [string, ReactNode]] : []),
    ...repoFacts(session),
    ['Tokens', <span className="num">{tokens ? compact(tokens) : 'None yet'}</span>],
    ['Cost', <span className="num">{usd(session.stats.costUsd)}{worthLine(session.stats) ? `, ${worthLine(session.stats)}` : ''}</span>],
    ['Started', <span className="num">{startedWords(session.createdAt)}</span>],
  ];

  return (
    <>
      <Sheet open={open} onClose={onClose} title={session.title}>
        <dl className="m-0 px-4">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-h-11 items-center gap-4">
              <dt className="w-24 shrink-0 text-[15px] text-fg-3">{k}</dt>
              <dd className="m-0 min-w-0 flex-1 truncate text-right text-[15px] text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        <div aria-hidden className="mx-4 my-2 h-px bg-rule" />
        <div className="px-2 pb-3">
          {live && <Action onClick={() => (onClose(), chat ? void stopChat(session.id) : void attempt(() => api().abort(session.id)))}>Stop</Action>}
          {isDelegated(session) && <Action onClick={() => (onClose(), void moveToMainList(session.id))}>{MOVE_TO_MAIN}</Action>}
          <Action onClick={later(() => setRenaming(true))}>Rename</Action>
          <RepoSheetActions session={session} onClose={onClose} Action={Action} />
          {/* Send to friend (FRIENDS.md phase 2): pick friends, review what goes, send */}
          <SendToFriendAction session={session} onOpen={later(() => setSend(true))} />
          <Action onClick={archive}>{session.archived ? 'Unarchive' : 'Archive'}</Action>
          {chat ? <Action onClick={later(() => openContinue(session.id))}>Move to Code</Action> : <Action onClick={toChat}>Move to Chat</Action>}
          {!chat && <Action onClick={later(() => setDetails(true))}>Details</Action>}
          <Action tone="fault" onClick={later(() => setDel(true))}>
            Delete
          </Action>
        </div>
      </Sheet>
      <RenameDialog session={session} open={renaming} onClose={() => setRenaming(false)} />
      {arch.dialog}
      <SendToFriendDialog session={session} open={send} onClose={() => setSend(false)} />
      {!chat && (
        <Sheet open={details} onClose={() => setDetails(false)} title="Details">
          <ContextPanel session={session} />
        </Sheet>
      )}
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${session.title}?`}
        body={session.stats.messages ? `Its ${session.stats.messages} messages leave the hub. Archive keeps them out of the list instead.` : 'It leaves the hub. This cannot be undone.'}
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          const ok = await attempt(() => api().deleteSession(session.id));
          if (!ok) return;
          navigate(list, { replace: true });
          removeKey('sessions', session.id);
        }}
      />
    </>
  );
}

function Action({ children, onClick, tone }: { children: ReactNode; onClick: () => void; tone?: 'fault' }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex min-h-12 w-full items-center rounded-[10px] px-2 text-left text-[16px] active:bg-hover', tone === 'fault' ? 'text-fault' : 'text-fg')}>
      {children}
    </button>
  );
}

function RenameDialog({ session, open, onClose }: { session: Session; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (open) setTitle(session.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = () => {
    onClose();
    const t = title.trim();
    if (t && t !== session.title) void patchChat(session.id, { title: t });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isChat(session) ? 'Rename chat' : 'Rename session'}
      footer={
        <>
          <Button variant="quiet" size="touch" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size="touch" disabled={!title.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      </form>
    </Dialog>
  );
}
