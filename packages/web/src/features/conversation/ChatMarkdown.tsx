/**
 * Reply prose for the Chat page: markdown at the chat size (t-chat), code in
 * boxes with Copy (swaps to Check) and, for html and svg, Preview. Links open
 * in a new tab. The static violet caret follows the text while it streams.
 */
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/text';
import { useCopy } from '@/lib/hooks';
import { highlight } from '@/lib/highlight';
import { Swap } from '@/components/motion';
import { ImageLink, isCodeFenceClosed, useThrottledText } from '@/features/chat/Markdown';
import { openPreview, useChatUi } from './state';
import './chat.css';

type PreviewLang = 'html' | 'svg';

/** html and svg blocks preview; an xml block previews when its first element is <svg>. */
export function previewLang(lang: string | undefined, code: string): PreviewLang | undefined {
  if (lang === 'html' || lang === 'htm') return 'html';
  if (lang === 'svg') return 'svg';
  if (lang === 'xml' && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(code)) return 'svg';
  return undefined;
}

const LANG_WORD: Record<string, string> = { sh: 'sh', bash: 'bash', zsh: 'zsh', ts: 'ts', tsx: 'tsx', js: 'js', py: 'python', python: 'python', html: 'html', svg: 'svg', css: 'css', json: 'json', http: 'http', caddyfile: 'caddyfile', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', go: 'go', rust: 'rust', rs: 'rust' };

export function ChatCode({ code, lang, closed = true, previewKey }: { code: string; lang?: string; closed?: boolean; previewKey?: string }) {
  const [copied, copy] = useCopy();
  // while the fence is still open the code changes on every delta: highlighting it each time is wasted, it renders as plain text until the fence closes
  const html = useMemo(() => (closed ? highlight(code, lang) : null), [closed, code, lang]);
  const pv = previewLang(lang, code);
  const open = useChatUi((s) => (previewKey ? s.preview?.key === previewKey : false));
  return (
    <div data-preview-key={pv ? (previewKey ?? code.slice(0, 64)) : undefined} className="cv-code group/code my-3 min-w-0 rounded-[var(--r-2)] border border-rule bg-sunk">
      <div className="flex h-8 items-center gap-1 pr-1 pl-3 coarse:h-11">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{lang ? (LANG_WORD[lang] ?? lang) : 'text'}</span>
        {pv && closed && (
          <button
            type="button"
            aria-pressed={open}
            onClick={() => openPreview({ key: previewKey ?? code.slice(0, 64), lang: pv, code })}
            className={cn('h-[26px] rounded-[var(--r-1)] px-2 text-[12.5px] font-medium transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg coarse:h-11 coarse:px-3', open ? 'bg-hover text-fg' : 'text-fg-2')}
          >
            Preview
          </button>
        )}
        <button
          type="button"
          onClick={() => copy(code)}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 opacity-0 transition-[opacity,color,background-color] duration-[var(--dur-1)] group-hover/code:opacity-100 hov:bg-hover hov:text-fg focus-visible:opacity-100 coarse:size-11 coarse:opacity-100"
        >
          <Swap on={copied} off={<Copy className="size-3.5" strokeWidth={1.75} />}>
            <Check className="size-3.5 text-ok" strokeWidth={1.75} />
          </Swap>
        </button>
      </div>
      <pre className="t-code m-0 overflow-x-auto px-3 pb-2.5 text-fg">{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
    </div>
  );
}

/** The markdown source and a key base, so code blocks can tell whether their fence closed. */
const Source = createContext<{ text: string; id: string }>({ text: '', id: 'md' });

function BlockCode({ className, children, node }: { className?: string; children?: ReactNode; node?: { position?: { start: { offset?: number }; end: { offset?: number } } } }) {
  const src = useContext(Source);
  const m = /language-([\w+-]+)/.exec(className ?? '');
  const text = String(children ?? '');
  const isBlock = Boolean(m) || text.includes('\n');
  if (!isBlock) return <code>{children}</code>;
  const lang = m?.[1]?.toLowerCase();
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  const raw = start !== undefined && end !== undefined ? src.text.slice(start, end).trimEnd() : '';
  // while streaming, an open fence runs to the end of the text; the block is closed once its last line is a fence
  const closed = isCodeFenceClosed(raw);
  return <ChatCode code={text.replace(/\n$/, '')} lang={lang} closed={closed} previewKey={`${src.id}:${start ?? 0}`} />;
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: BlockCode as Components['code'],
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ImageLink,
  table: ({ children }) => <table>{children}</table>,
};

/** Markdown at the chat size. `id` keys previews to their block. */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming, className, id = 'md' }: { text: string; streaming?: boolean; className?: string; id?: string }) {
  const shown = useThrottledText(text, streaming);
  const ctx = useMemo(() => ({ text: shown, id }), [shown, id]);
  const markdown = useMemo(() => <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{shown}</ReactMarkdown>, [shown]);
  return (
    <Source.Provider value={ctx}>
      <div className={cn('md md-chat', streaming && 'md-streaming', className)}>
        {markdown}
      </div>
    </Source.Provider>
  );
});

/** Plain text in a bubble: keeps line breaks, never renders markdown. */
export function PlainText({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('t-chat break-words whitespace-pre-wrap', className)}>{children}</div>;
}
