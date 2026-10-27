/**
 * A page on the hub's browser, shown here: its newest frame as a picture,
 * polled about twice a second (the hub answers 204 when nothing changed).
 * When `interactive`, clicks, scrolling (a swipe on a phone), keys and text
 * go back to it, with an address bar and a box to type in. Settings >
 * Browser's sign-in view and a chat session's live view (BrowserLive.tsx)
 * both draw it.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent, type WheelEvent } from 'react';
import type { BrowserInputEvent, SignInFrameDto } from '@conclave/core/client';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { errText } from './parts';

/** Keys the view sends as key presses; everything printable goes as text. */
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function RemotePage({
  viewKey,
  poll,
  send: sendRaw,
  interactive,
  startUrl = '',
  phoneWidth = false,
  problem: outer,
  help,
}: {
  /** A new key starts polling again from the first frame. */
  viewKey: string;
  poll: (after: number) => Promise<SignInFrameDto | undefined>;
  send: (events: BrowserInputEvent[]) => Promise<unknown>;
  interactive: boolean;
  startUrl?: string;
  /** On a phone, ask the page for a phone's width (the sign-in view; not an agent's page). */
  phoneWidth?: boolean;
  problem?: string;
  help: string;
}) {
  const phone = useIsMobile();
  const [frame, setFrame] = useState<SignInFrameDto>();
  const [problem, setProblem] = useState<string>();
  const [text, setText] = useState('');
  const [address, setAddress] = useState(startUrl);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const wheel = useRef(0);

  useEffect(() => {
    let live = true;
    seq.current = 0;
    const tick = async () => {
      while (live) {
        try {
          const f = await poll(seq.current);
          if (!live) return;
          if (f) {
            seq.current = f.seq;
            setFrame(f);
            setProblem(undefined);
          }
        } catch (e) {
          if (!live) return;
          setProblem(errText(e));
        }
        await new Promise((r) => setTimeout(r, 450));
      }
    };
    void tick();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  useEffect(() => {
    if (frame?.url) setAddress(frame.url);
  }, [frame?.url]);

  const send = (events: BrowserInputEvent[]) => {
    if (!interactive) return Promise.resolve();
    return sendRaw(events).catch((e) => setProblem(errText(e)));
  };

  // a phone gets the page at a phone's width, so the site lays it out to be read at that size
  useEffect(() => {
    if (phone && phoneWidth) void send([{ type: 'resize', width: 400, height: 720 }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, phone, phoneWidth]);

  const point = (e: MouseEvent | WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = frame?.width ?? r.width;
    const h = frame?.height ?? r.height;
    return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * h) };
  };
  const onClick = (e: MouseEvent) => {
    const p = point(e);
    box.current?.focus();
    void send([
      { type: 'mouse', action: 'move', ...p },
      { type: 'mouse', action: 'down', ...p, button: 'left' },
      { type: 'mouse', action: 'up', ...p, button: 'left' },
    ]);
  };
  const onWheel = (e: WheelEvent) => {
    const now = Date.now();
    if (now - wheel.current < 120) return;
    wheel.current = now;
    void send([{ type: 'mouse', action: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY }]);
  };
  // a phone has no wheel: a swipe on the picture scrolls the page on the hub
  const swipe = useRef<number | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    swipe.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    const end = e.changedTouches[0];
    if (start === null || !end) return;
    const dy = start - end.clientY;
    if (Math.abs(dy) < 24) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = (frame?.height ?? r.height) / r.height;
    void send([{ type: 'mouse', action: 'wheel', x: Math.round((frame?.width ?? r.width) / 2), y: Math.round((frame?.height ?? r.height) / 2), deltaX: 0, deltaY: Math.round(dy * scale) }]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      void send([{ type: 'text', text: e.key }]);
    } else if (KEYS.has(e.key)) {
      e.preventDefault();
      void send([
        { type: 'key', action: 'down', key: e.key },
        { type: 'key', action: 'up', key: e.key },
      ]);
    }
  };
  const press = (key: string) =>
    void send([
      { type: 'key', action: 'down', key },
      { type: 'key', action: 'up', key },
    ]);
  const typeText = () => {
    if (!text) return;
    void send([{ type: 'text', text }]);
    setText('');
  };
  const shown = outer ?? problem;
  // a phone's fields are 44px tall: the buttons beside them match
  const btn = phone ? 'touch' : 'sm';

  return (
    <>
      {interactive && (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send([{ type: 'navigate', url: address }]);
          }}
        >
          <Input mono size="sm" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address" spellCheck={false} inputMode="url" />
          <Button size={btn} type="submit">
            Go
          </Button>
        </form>
      )}
      <div
        ref={box}
        tabIndex={interactive ? 0 : -1}
        role={interactive ? 'application' : 'img'}
        aria-label={interactive ? 'The page on the hub. Click to focus, then type.' : 'The page on the hub, live'}
        onKeyDown={interactive ? onKey : undefined}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (t) void send([{ type: 'text', text: t }]);
        }}
        className="relative flex min-h-[200px] justify-center overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-sunk outline-none focus-visible:border-signal"
      >
        {frame ? (
          // the picture keeps the page's shape and fits the dialog; clicks map from its own box
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="The page on the hub"
            draggable={false}
            onClick={interactive ? onClick : undefined}
            onWheel={interactive ? onWheel : undefined}
            onTouchStart={interactive ? onTouchStart : undefined}
            onTouchEnd={interactive ? onTouchEnd : undefined}
            className={cn('block h-auto w-auto max-w-full select-none', interactive ? 'cursor-default touch-pan-x' : 'cursor-not-allowed')}
            style={{ maxHeight: phone ? '44dvh' : '44vh', aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : (
          <p className="absolute inset-0 grid place-items-center text-[13px] text-fg-3">Opening the page</p>
        )}
      </div>
      {interactive && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className={cn('min-w-0 flex-1', phone && 'basis-full')}>
            <Input
              size="sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  typeText();
                }
              }}
              placeholder="Type here, then Send"
              aria-label="Text to type into the page"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button size={btn} onClick={typeText} disabled={!text}>
            Send
          </Button>
          <Button size={btn} variant="quiet" onClick={() => press('Enter')}>
            Enter
          </Button>
          <Button size={btn} variant="quiet" onClick={() => press('Tab')}>
            Tab
          </Button>
          <Button size={btn} variant="quiet" onClick={() => press('Backspace')}>
            Delete
          </Button>
        </div>
      )}
      <p className="mt-2 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{shown ? <span className="text-fault">{shown}</span> : help}</p>
    </>
  );
}
