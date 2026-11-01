/**
 * Previews of html and svg blocks (docs/design/CHAT-AND-MOTION.md 2.7). A
 * right panel on desktop, a full height sheet on phones and tablets. The page
 * runs in an iframe with an empty sandbox and a CSP that blocks the network;
 * "Allow scripts" adds allow-scripts only, never allow-same-origin.
 *
 * Card to panel (spec 1.4): the panel grows out of its code block (a
 * container transform, 420ms on --ease-emph, the content fading in from
 * 110ms) and closing shrinks it back into the block (320ms, --ease-std).
 * Transform and opacity only; the content is counter-scaled so it never
 * stretches. Reduced motion: it opens and closes in place.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '@/lib/text';
import { useCopy } from '@/lib/hooks';
import { highlight } from '@/lib/highlight';
import { Button, IconButton } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { useFocusTrap } from '@/components/ui/Overlay';
import { EASE, Swap, growFrames, useHeld, usePresence, useReducedMotion } from '@/components/motion';
import { closePreview, useChatUi, type PreviewDoc } from './state';

const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/** The document the frame shows: the CSP goes first, before anything that could load. */
export function previewDocument(doc: PreviewDoc, scripts: boolean): string {
  const csp = scripts ? `${CSP}; script-src 'unsafe-inline'` : CSP;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8">`;
  if (doc.lang === 'svg')
    return `<!doctype html><html><head>${meta}<style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${doc.code}</body></html>`;
  const code = doc.code.trim();
  const doctype = /^<!doctype[^>]*>/i.exec(code);
  if (doctype) return `${doctype[0]}${meta}${code.slice(doctype[0].length)}`;
  return `<!doctype html>${meta}${code}`;
}

function download(doc: PreviewDoc) {
  const blob = new Blob([doc.code], { type: doc.lang === 'svg' ? 'image/svg+xml' : 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `preview.${doc.lang}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** sheet: phone and tablet sizes. stacked: the header in two rows (a sheet, or a narrow panel). */
function PreviewBody({ doc, sheet, stacked = sheet }: { doc: PreviewDoc; sheet: boolean; stacked?: boolean }) {
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [scripts, setScripts] = useState(false);
  const [copied, copy] = useCopy();
  const srcdoc = useMemo(() => previewDocument(doc, scripts), [doc, scripts]);
  const html = useMemo(() => (view === 'code' ? highlight(doc.code, doc.lang === 'svg' ? 'xml' : 'html') : null), [doc, view]);
  // a new block resets the view; scripts reset when the panel closes (this unmounts)
  useEffect(() => setView('preview'), [doc.key]);

  const scriptsControl = (
    <span className="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-fg-3">
      Allow scripts
      <Segmented
        size={sheet ? 'md' : 'sm'}
        label="Allow scripts"
        value={scripts ? 'on' : 'off'}
        onChange={(v) => setScripts(v === 'on')}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
    </span>
  );
  const tools = (
    <>
      <IconButton label={copied ? 'Copied' : 'Copy'} size={sheet ? 'touch' : 'sm'} onClick={() => copy(doc.code)}>
        <Swap on={copied} off={<Copy />}>
          <Check className="text-ok" />
        </Swap>
      </IconButton>
      <Button variant="quiet" size={sheet ? 'touch' : 'sm'} onClick={() => download(doc)}>
        Download
      </Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex shrink-0 items-center gap-3 border-b border-rule', sheet ? 'h-14 px-4' : 'h-[52px] pr-2 pl-5')}>
        <span className="t-section shrink-0 text-fg">{doc.lang === 'svg' ? 'SVG' : 'HTML'}</span>
        <Segmented
          size={sheet ? 'md' : 'sm'}
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'code', label: 'Code' },
          ]}
        />
        <span className="flex-1" />
        {!stacked && (
          <>
            {scriptsControl}
            <span aria-hidden className="h-3.5 w-px bg-rule" />
            {tools}
          </>
        )}
        <IconButton label="Close preview" size={sheet ? 'touch' : 'md'} onClick={closePreview} className={sheet ? '-mr-2' : undefined}>
          <X />
        </IconButton>
      </div>
      {stacked && (
        <div className={cn('flex h-12 shrink-0 items-center gap-2 border-b border-rule', sheet ? 'px-4' : 'pr-2 pl-5')}>
          {scriptsControl}
          <span className="flex-1" />
          {tools}
        </div>
      )}
      {scripts && <p className="shrink-0 border-b border-rule px-5 py-2 text-[12px] text-fg-3 phone:px-4 phone:text-[13px]">Scripts run in a sandbox with no network and no access to Conclave.</p>}
      <div className="relative min-h-0 flex-1 bg-sunk">
        {view === 'preview' ? (
          <iframe key={scripts ? 'scripts' : 'static'} title={`${doc.lang === 'svg' ? 'SVG' : 'HTML'} preview`} sandbox={scripts ? 'allow-scripts' : ''} srcDoc={srcdoc} referrerPolicy="no-referrer" className="absolute inset-0 size-full border-0 bg-white" />
        ) : (
          <pre className="t-code absolute inset-0 m-0 overflow-auto p-4 text-fg">{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{doc.code}</code>}</pre>
        )}
      </div>
    </div>
  );
}

/** A panel narrower than this puts Allow scripts, Copy and Download on a second row. */
const STACK_BELOW = 600;

const OPEN_MS = 420;
const CLOSE_MS = 320;

/** The code block a preview came from (ChatCode marks it), or null when it scrolled out of the page. */
function blockOf(doc: PreviewDoc): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-preview-key="${CSS.escape(doc.key)}"]`);
}

/**
 * Grow the panel out of its code block when a preview opens, and shrink it
 * back into the block while it closes (`leaving`). The panel's box moves and
 * scales; `body` is counter-scaled so the page inside never stretches.
 */
function useGrowFromBlock(panel: RefObject<HTMLElement | null>, body: RefObject<HTMLElement | null>, doc: PreviewDoc | undefined, leaving: boolean) {
  const reduced = useReducedMotion();
  const anims = useRef<Animation[]>([]);
  const stop = () => {
    for (const x of anims.current) x.cancel();
    anims.current = [];
    if (panel.current) delete panel.current.dataset.moving;
  };
  const key = doc?.key;
  useLayoutEffect(() => {
    const p = panel.current;
    const c = body.current;
    const src = doc && blockOf(doc);
    if (reduced || leaving || !p || !c || !src) return;
    stop();
    const a = src.getBoundingClientRect();
    const b = p.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const { outer, inner } = growFrames(a, b, EASE.emph, false);
    // while it moves the box reads as the code block it grows out of (its surface and hairline)
    p.dataset.moving = '';
    const list = [p.animate(outer, { duration: OPEN_MS, fill: 'both' }), c.animate(inner, { duration: OPEN_MS, fill: 'both' }), c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 230, delay: 110, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' })];
    // once it lands the panel is plain again
    list[0].onfinish = stop;
    anims.current = list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLayoutEffect(() => {
    const p = panel.current;
    const c = body.current;
    const src = doc && blockOf(doc);
    if (!leaving || reduced || !p || !c || !src) return;
    stop();
    const a = src.getBoundingClientRect();
    const b = p.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const { outer, inner } = growFrames(a, b, EASE.std, true);
    p.dataset.moving = '';
    anims.current = [p.animate(outer, { duration: CLOSE_MS, fill: 'both' }), c.animate(inner, { duration: CLOSE_MS, fill: 'both' }), c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }), p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, delay: CLOSE_MS - 90, fill: 'both' })];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);
  useEffect(() => () => stop(), []);
}

/** The preview to show, kept through its close so the panel can shrink back into its block. */
function usePreviewPresence() {
  const doc = useChatUi((s) => s.preview);
  const reduced = useReducedMotion();
  // a block that scrolled away (or reduced motion) closes at once; otherwise the panel shrinks into it
  const held = useHeld(!!doc, doc);
  const { mounted, leaving } = usePresence(!!doc, held && !reduced && blockOf(held) ? CLOSE_MS : 0);
  return { doc: mounted ? (doc ?? held) : undefined, leaving, fromBlock: !!doc && !reduced && !!blockOf(doc) };
}

/** Desktop: a panel at the right of the chat column, in the layout. */
export function PreviewPanel({ width }: { width: number }) {
  const { doc, leaving, fromBlock } = usePreviewPresence();
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // while it shrinks back into its block the panel keeps its place; the column widens in one frame after
  const w = useHeld(!leaving && width > 0, width);
  useEscClose(!!doc && !leaving);
  useGrowFromBlock(panel, body, doc, leaving);
  if (!doc) return null;
  return (
    <aside
      ref={panel}
      aria-label="Preview"
      inert={leaving || undefined}
      style={{ width: w, transformOrigin: '0 0' }}
      className={cn('cv-preview relative z-10 flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-rule bg-bg', !fromBlock && !leaving && 'anim-right')}
    >
      <div ref={body} className="flex h-full min-h-0 flex-col" style={{ transformOrigin: '0 0' }}>
        <PreviewBody doc={doc} sheet={false} stacked={w < STACK_BELOW} />
      </div>
    </aside>
  );
}

/** Phones and tablets: a full height sheet with the same header. */
export function PreviewSheet() {
  const { doc, leaving, fromBlock } = usePreviewPresence();
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEscClose(!!doc && !leaving);
  useFocusTrap(ref, !!doc && !leaving);
  useGrowFromBlock(ref, body, doc, leaving);
  if (!doc) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Preview"
      tabIndex={-1}
      inert={leaving || undefined}
      style={{ transformOrigin: '0 0' }}
      className={cn('cv-preview fixed inset-0 z-[70] overflow-hidden bg-raise outline-none', !fromBlock && !leaving && 'anim-sheet')}
    >
      <div ref={body} className="flex h-full flex-col pt-safe pb-safe" style={{ transformOrigin: '0 0' }}>
        <PreviewBody doc={doc} sheet />
      </div>
    </div>,
    document.body,
  );
}

function useEscClose(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // a menu or dialog above the panel closes first
      if (document.querySelector('[role=dialog][aria-modal=true]:not([aria-label="Preview"]), [role=menu]')) return;
      e.preventDefault();
      closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
