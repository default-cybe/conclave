/**
 * Your message on the Chat page (docs/design/CHAT-AND-MOTION.md 2.6): a quiet
 * right aligned bubble, attachments above it, Edit and Copy and the time
 * under it on hover (always on touch). Edit turns the bubble into a
 * textarea in place; Send replaces this message and everything after it.
 * On a phone a tap on the bubble opens Copy and Edit; a long press selects
 * its text, as anywhere else.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { X } from 'lucide-react';
import type { AttachmentReceipt, ContentBlock, Message, QueuedMessage, Session } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { dayTime, hhmm } from '@/lib/format';
import { isImportedMessage, splitAttached } from '@conclave/core/session/imported';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Dialog, MenuList, Popover } from '@/components/ui/Overlay';
import { ImageThumb } from '@/components/ui/ImageViewer';
import { Swap } from '@/components/motion';
import { pendingPreview, removeQueued, useHub } from '@/store/store';
import { msgText } from '@/features/chat/util';
import { PersonLine, senderName } from '@/features/chat/shared';
import { pendingWord, SendHeld, storedWord } from '@/features/chat/Pending';
import { attachmentsOf, branchChat, replaceFrom } from './actions';
import { BUBBLE, BubbleText } from '@/components/ui/Bubble';
import { PlainText } from './ChatMarkdown';
import { Act } from './Reply';
import { setEditing, useChatUi, type Pending } from './state';


function Attachments({ images, files }: { images: string[]; files: string[] }) {
  if (!images.length && !files.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-2">
      {images.map((src, i) => (
        <ImageThumb key={i} src={src} className="max-h-40 max-w-[240px] rounded-[var(--r-2)] border border-rule object-cover" />
      ))}
      {files.map((f, i) => (
        <span key={`f${i}`} className="flex h-10 items-center rounded-[var(--r-2)] border border-rule px-3 text-[13px] text-fg-2">
          {f}
        </span>
      ))}
    </div>
  );
}

function imagesOf(m: Message): string[] {
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').map((b) => b.url ?? `data:${b.mediaType};base64,${b.data}`);
}

function filesOf(m: Message): string[] {
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'document' }> => b.type === 'document').map((b) => b.title ?? 'Document');
}

function receiptsOf(m: Message): AttachmentReceipt[] {
  return Array.isArray(m.meta?.attachments) ? (m.meta.attachments as AttachmentReceipt[]) : [];
}

/** How one attached file fared, in one quiet line. Included means the request carried it, never that the model read it. */
function receiptWord(r: AttachmentReceipt): string {
  if (r.state === 'omitted') return `${r.name}: not included (${r.reason})`;
  if (r.included === false) return `${r.name}: left out of the request (${r.reason})`;
  if (r.as && r.as.length > 1) return `${r.name}: included, expanded as ${r.as.join(', ')}`;
  return r.included ? `${r.name}: included` : `${r.name}: attached`;
}

export const UserMessage = memo(function UserMessage({ message, session, after, queued }: { message: Message; session: Session; /** Replies an edit would remove. */ after: number; /** Waits for the running reply to end. */ queued?: boolean }) {
  // while an edit goes out, the bubble already shows the new text
  const replacing = useChatUi((s) => (s.pending[session.id]?.key === message.id ? s.pending[session.id]?.text : undefined));
  // an imported message's attachments are text blocks for the model; here they are file chips (core session/imported.ts)
  const imported = isImportedMessage(message);
  const split = imported ? splitAttached(message.content) : undefined;
  const text = replacing ?? split?.text ?? msgText(message);
  const [copied, copy] = useCopy();
  const editing = useChatUi((s) => s.editing[session.id] === message.id);
  const leaving = useChatUi((s) => s.leaving.has(message.id));
  const mobile = useIsMobile();
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  // a phone: a tap opens Copy and Edit; a press that selected text, or a tap on a link, does not
  const onTap = mobile
    ? (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && anchor.current?.contains(sel.anchorNode)) return;
        setMenu(true);
      }
    : undefined;
  const recalled = Array.isArray(message.meta?.recalled) ? (message.meta.recalled as string[]) : [];
  // a row per attachment only when something needs saying; plain included files are the chips above
  const receipts = receiptsOf(message);
  const receiptLines = receipts.filter((r) => r.state === 'omitted' || r.included === false || (r.as && r.as.length > 1));
  // sent while a reply ran: "Queued" with the actions under the bubble, and on a phone on its own quiet line, where the waiting bubble said it (QueuedBubble)
  const busyWord = storedWord(message.meta?.whenBusy);

  if (editing) return <EditBox message={message} session={session} after={after} />;
  // another person's words in a shared chat (SHARED-WITH-MEMBERS.md 6): their name, not the owner's bubble
  const from = senderName(message, useHub.getState().me?.id ?? 'owner');
  if (from)
    return (
      <div id={`cm-${message.id}`} className="flex flex-col items-start" data-shared-from={from}>
        <PersonLine name={from}>
          <span className="num">{hhmm(message.createdAt)}</span>
        </PersonLine>
        <div className={cn(BUBBLE, 'max-w-[min(85%,520px)] phone:max-w-[85%]')}>
          <BubbleText text={text} />
        </div>
      </div>
    );
  if (queued)
    return (
      <div id={`cm-${message.id}`} className="flex flex-col items-end">
        {text && (
          <div className={cn(BUBBLE.replace('text-fg', 'text-fg-2'), 'max-w-[min(85%,520px)] phone:max-w-[85%]')}>
            <PlainText>{text}</PlainText>
          </div>
        )}
      </div>
    );

  return (
    <div id={`cm-${message.id}`} className={cn('group/user relative flex flex-col items-end', leaving && 'cv-leave')}>
      <Attachments images={imagesOf(message)} files={[...filesOf(message), ...(split?.files ?? [])]} />
      {receiptLines.length > 0 && (
        <div className="mb-1.5 flex flex-col items-end gap-0.5 text-[12px] text-fg-3 phone:text-[13px]">
          {receiptLines.map((r, i) => (
            <span key={`r${i}`}>{receiptWord(r)}</span>
          ))}
        </div>
      )}
      {text && (
        <div ref={anchor} className={cn(BUBBLE, 'max-w-[min(85%,520px)] phone:max-w-[85%]')} onClick={onTap}>
          <BubbleText text={text} />
        </div>
      )}
      {mobile && text && (
        <button type="button" className="sr-only" aria-haspopup="menu" onClick={() => setMenu(true)}>
          Actions for your message
        </button>
      )}
      {busyWord && <span className="mt-1 hidden h-6 items-center px-1 text-[13px] text-fg-3 phone:flex">{busyWord}</span>}
      {/* hover actions sit in the gap under the bubble on desktop; always shown, in the flow, on touch; a phone has them on a tap */}
      <div className="absolute top-full right-0 mt-0.5 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover/user:opacity-100 group-focus-within/user:opacity-100 coarse:static coarse:mt-1 coarse:h-9 coarse:opacity-100 phone:hidden">
        {busyWord && <span className="mr-1 text-[12px] text-fg-3">{busyWord}</span>}
        {recalled.length > 0 && (
          <Link href={`/memory?focus=${recalled[0]}`} className="mr-2 text-[12px] text-fg-3 hov:text-fg phone:text-[13px]">
            Used {recalled.length} {recalled.length === 1 ? 'note' : 'notes'} from memory
          </Link>
        )}
        <span className="num mr-1 text-[12px] text-fg-3 phone:text-[13px]">{imported ? dayTime(message.createdAt) : hhmm(message.createdAt)}</span>
        {!mobile && (
          <Act onClick={() => setEditing(session.id, message.id)} label="Edit">
            Edit
          </Act>
        )}
        <Act onClick={() => copy(text)} label={copied ? 'Copied' : 'Copy'}>
          <Swap on={copied} off="Copy">
            Copied
          </Swap>
        </Act>
        {mobile && (
          <Act onClick={() => setEditing(session.id, message.id)} label="Edit">
            Edit
          </Act>
        )}
      </div>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} label="Message actions" sheetTitle="Your message">
        <MenuList
          onDone={() => setMenu(false)}
          label="Message actions"
          items={[
            { label: copied ? 'Copied' : 'Copy', onSelect: () => copy(text) },
            { label: 'Edit', onSelect: () => setEditing(session.id, message.id) },
          ]}
        />
      </Popover>
    </div>
  );
});

/** Edits the hub refused before anything changed: the editor opens again with your words. */
const editDrafts = new Map<string, string>();

/** The bubble as a textarea, in place: Cancel and Send. Confirms before more than two replies go. */
function EditBox({ message, session, after }: { message: Message; session: Session; after: number }) {
  const [value, setValue] = useState(() => {
    const kept = editDrafts.get(message.id);
    editDrafts.delete(message.id);
    return kept ?? msgText(message);
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [, navigate] = useLocation();
  const mobile = useIsMobile();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // grow with the text, up to 12 lines
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, lh * 12 + 20)}px`;
  }, [value]);

  const cancel = () => setEditing(session.id, undefined);
  const save = async () => {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    setEditing(session.id, undefined);
    const ok = await replaceFrom(session, message, { text, attachments: attachmentsOf(message) });
    // refused before the rewind: the message is still there, so edit it again; after it, the composer has the text
    if (!ok && useHub.getState().messages[session.id]?.some((m) => m.id === message.id)) {
      editDrafts.set(message.id, text);
      setEditing(session.id, message.id);
    }
    setBusy(false);
  };
  const trySave = () => {
    if (!value.trim()) return;
    if (after > 2) setConfirm(true);
    else void save();
  };

  return (
    <div id={`cm-${message.id}`} className="flex flex-col items-end">
      <div className="w-full max-w-[min(100%,620px)] rounded-[var(--r-2)] border border-edge bg-sunk focus-within:border-signal focus-within:shadow-[0_0_0_1px_var(--signal)]">
        <textarea
          ref={box}
          value={value}
          aria-label="Edit your message"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !mobile) {
              e.preventDefault();
              trySave();
            }
          }}
          // never under 16px on a phone, at any Text size: iOS zooms into a smaller field
          className="t-chat block w-full resize-none bg-transparent px-3.5 py-2.5 text-fg outline-none phone:text-[length:max(16px,var(--read-size))]"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="quiet" size={mobile ? 'touch' : 'sm'} onClick={cancel}>
          Cancel
        </Button>
        <Button variant="solid" size={mobile ? 'touch' : 'sm'} disabled={!value.trim()} busy={busy ? 'Sending' : false} onClick={trySave}>
          Send
        </Button>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Edit this message?"
        footer={
          <>
            <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size={mobile ? 'touch' : 'md'}
              onClick={async () => {
                setConfirm(false);
                await branchChat(session, undefined, navigate, { stay: true });
                await save();
              }}
            >
              Branch
            </Button>
            <Button
              variant="solid"
              size={mobile ? 'touch' : 'md'}
              onClick={() => {
                setConfirm(false);
                void save();
              }}
            >
              Edit
            </Button>
          </>
        }
      >
        <p>
          The {after} replies after it go away. Branch first to keep them.
        </p>
      </Dialog>
    </div>
  );
}

/**
 * What you sent while a reply runs, before its turn takes it
 * (docs/design/CHAT-AND-MOTION.md 2.11): the bubble it will be, with an x and
 * "Queued" where Edit and Copy will be (always shown). When the hub stores it,
 * the message takes this row (the same key) and nothing moves.
 */
export function QueuedBubble({ item, chatId }: { item: QueuedMessage; chatId: string }) {
  const local = pendingPreview(item.id) ?? [];
  const images = local.filter((a) => a.mediaType.startsWith('image/') && a.data).map((a) => `data:${a.mediaType};base64,${a.data}`);
  const files = (item.attachments ?? []).filter((a) => !(a.mediaType.startsWith('image/') && images.length)).map((a) => a.name ?? 'Document');
  return (
    <div data-pending={item.whenBusy} className="relative flex flex-col items-end">
      <Attachments images={images} files={files} />
      {item.text && (
        <div className={cn(BUBBLE, 'max-w-[min(85%,520px)] phone:max-w-[85%]')}>
          <BubbleText text={item.text} />
        </div>
      )}
      <div className="absolute top-full right-0 mt-0.5 flex h-6 items-center gap-1 coarse:static coarse:mt-1 coarse:h-9 phone:mt-1! phone:h-6! phone:px-1">
        <button type="button" aria-label="Remove" title="Remove" onClick={() => void removeQueued(chatId, item.id)} className="tap grid size-6 place-items-center rounded-[var(--r-1)] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg phone:size-4">
          <X aria-hidden strokeWidth={1.75} className="size-3.5" />
        </button>
        <span className="text-[12px] text-fg-3 phone:text-[13px]">{pendingWord(item)}</span>
        <SendHeld sessionId={chatId} item={item} className="ml-1 phone:text-[13px]" />
      </div>
    </div>
  );
}

/** What you just sent, before the hub has it. */
export function PendingMessage({ pending }: { pending: Pending }) {
  return (
    <div className={cn('flex flex-col items-end', !pending.key && 'anim-rise')}>
      <Attachments images={pending.images} files={pending.files} />
      {pending.text && (
        <div className={cn(BUBBLE, 'max-w-[min(85%,520px)] phone:max-w-[85%]')}>
          <PlainText>{pending.text}</PlainText>
        </div>
      )}
      {/* the same height as the action row under a sent message, so nothing moves when the hub's copy arrives */}
      <div className="mt-1 hidden h-9 coarse:block phone:hidden" aria-hidden />
    </div>
  );
}
