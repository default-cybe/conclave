/**
 * The composer on a phone (docs/design/MOBILE-V2.md 4): one rounded box,
 * surface-2, no border in dark and a hairline in light. The text on top,
 * growing to 6 lines; under it, inside the box: + (photos, camera, files),
 * the options (sliders), then at the right the model's short name, the mic
 * and Send, a 36px circle: filled violet with text, an outline when empty,
 * a stop square while it works.
 *
 * Layout only: the chat composer and the session composer each bring their
 * own field, options sheet and send, and the attachments as one row of
 * chips that scrolls sideways (ComposerParts.tsx AttachmentStrip), so the
 * field stays on screen with 15 files.
 */
import { forwardRef, useRef, useState, type ReactNode } from 'react';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { MenuList, Popover } from '@/components/ui/Overlay';
import { Rim, SendStopButton, type RimState } from '@/components/motion';

/** Lines the box grows to before it scrolls. */
export const PHONE_LINES = 6;

export function PhoneBox({
  rim,
  attachments,
  field,
  add,
  options,
  model,
  mic,
  send,
}: {
  rim: RimState;
  /** The row of attached files over the field (AttachmentStrip), when there are some. */
  attachments?: ReactNode;
  /** The textarea. */
  field: ReactNode;
  add: ReactNode;
  options?: ReactNode;
  model?: ReactNode;
  mic?: ReactNode;
  send: ReactNode;
}) {
  return (
    <div className="relative rounded-[24px] bg-surface-2 transition-[border-color] duration-[var(--dur-1)] light:border light:border-rule">
      {/* waiting on you, the card in the conversation says so: the edge stays quiet */}
      <Rim state={rim === 'waiting' ? 'idle' : rim} />
      {attachments}
      {field}
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        {add}
        {options}
        <span className="ml-auto flex min-w-0 items-center gap-0.5">
          {model}
          {mic}
          {send}
        </span>
      </div>
    </div>
  );
}

/** The field's classes: 16px so iOS does not zoom, the room the box gives it. */
export const PHONE_FIELD = 'block w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[16px] leading-[1.5] text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none';

/** Grow the field with its text up to PHONE_LINES, then scroll. */
export function fitField(el: HTMLTextAreaElement) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || 24;
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const max = lh * PHONE_LINES;
  const content = sizeField(el, (h) => Math.max(lh, Math.min(h - pad, max)) + pad) - pad;
  el.style.overflowY = content > max + 1 ? 'auto' : 'hidden';
}

/**
 * Set a field's height from its text: `size` gets the scrollHeight it has at
 * height 0 and returns the height. Returns that scrollHeight. The box around
 * the field keeps its height while it measures, so the page never sees the
 * field at 0: the transcript above grew into the room for that moment and,
 * without scroll anchoring (Safari, the Mac app), kept the scroll offset it
 * was clamped to, so each key moved the chat.
 */
export function sizeField(el: HTMLTextAreaElement, size: (scrollHeight: number) => number): number {
  const box = el.parentElement;
  const held = box?.style.height ?? '';
  if (box) box.style.height = `${box.getBoundingClientRect().height}px`;
  el.style.height = '0px';
  const h = el.scrollHeight;
  el.style.height = `${size(h)}px`;
  if (box) box.style.height = held;
  return h;
}

const ROUND = 'grid size-11 shrink-0 place-items-center rounded-full text-fg-2 transition-colors duration-[var(--dur-1)] active:bg-hover';

/** + : photos, camera or files, each its own picker. */
export function AddButton({ onFiles, accept }: { onFiles: (files: File[]) => void; accept: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const pick = (input: React.RefObject<HTMLInputElement | null>) => () => setTimeout(() => input.current?.click(), 0);
  const input = (r: React.RefObject<HTMLInputElement | null>, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      ref={r}
      type="file"
      className="hidden"
      onChange={(e) => {
        const list = Array.from(e.target.files ?? []);
        // cleared, so picking the same file again (after removing it) still fires
        e.target.value = '';
        if (list.length) onFiles(list);
      }}
      {...props}
    />
  );
  return (
    <>
      <button ref={ref} type="button" aria-label="Add photos or files" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)} className={ROUND}>
        <Plus className="size-[22px]" strokeWidth={1.75} aria-hidden />
      </button>
      {input(photos, { accept: 'image/*', multiple: true })}
      {input(camera, { accept: 'image/*', capture: 'environment' })}
      {input(files, { accept, multiple: true })}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label="Add" sheetTitle="Add">
        <MenuList
          onDone={() => setOpen(false)}
          label="Add"
          items={[
            { label: 'Photos', onSelect: pick(photos) },
            { label: 'Camera', onSelect: pick(camera) },
            { label: 'Files', onSelect: pick(files) },
          ]}
        />
      </Popover>
    </>
  );
}

/** The sliders: a sheet with the rest of the choices. */
export const OptionsButton = forwardRef<HTMLButtonElement, { onClick: () => void; label: string }>(function OptionsButton({ onClick, label }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} aria-haspopup="dialog" onClick={onClick} className={ROUND}>
      <SlidersHorizontal className="size-5" strokeWidth={1.75} aria-hidden />
    </button>
  );
});

/** The model's short name in fg-3; a tap opens the model list. */
export const ModelWord = forwardRef<HTMLButtonElement, { name: string; onClick: () => void; expanded?: boolean }>(function ModelWord({ name, onClick, expanded }, ref) {
  return (
    <button ref={ref} type="button" aria-label={`Model, ${name}`} aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick} className="flex h-11 min-w-0 items-center rounded-full px-2 text-[14px] text-fg-3 active:bg-hover">
      <span className="truncate">{name}</span>
    </button>
  );
});

/** Send in a 36px circle, with a 44px place to tap. `running`: a reply runs; with the box empty Send is Stop. */
export function PhoneSend({ running, ready, label, onSend, onStop, keepFocus }: { running: boolean; ready: boolean; label: string; onSend: () => void; onStop: () => void; keepFocus: () => boolean }) {
  return (
    <span className="grid size-11 shrink-0 place-items-center">
      <SendStopButton
        running={running && !ready}
        ready={ready}
        size={16}
        tone="accent"
        sendLabel={label}
        aria-disabled={!running && !ready ? true : undefined}
        // a press keeps the focus in the box, so the keyboard stays open after Send
        onMouseDown={(e) => {
          if (keepFocus()) e.preventDefault();
        }}
        onClick={running && !ready ? onStop : onSend}
        // the border sits inside the 36px circle: 5px out on each side makes the 44px place to tap
        className="relative size-9 rounded-full! after:absolute after:-inset-[5px]"
      />
    </span>
  );
}
