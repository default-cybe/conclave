import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/text';
import { CodeBlock } from '@/components/ui/Code';
import { InkReveal } from '@/components/motion/InkReveal';

/** A markdown image from a model shows as a link: loading it would send its URL, and whatever an injected prompt put in it, to that host. */
export function ImageLink({ src, alt }: { src?: string | Blob; alt?: string }) {
  const label = alt || 'Image';
  if (typeof src !== 'string' || !src) return <span>{label}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

const Source = createContext('');

/** Indented code is complete; a fenced block needs a matching fence of at least the opening length. */
export function isCodeFenceClosed(raw: string): boolean {
  const lines = raw.trimEnd().split('\n');
  const opening = /^\s*(`{3,}|~{3,})/.exec(lines[0]);
  if (!opening) return true;
  const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1]);
  return lines.length > 1 && !!closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length;
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, node, ...rest }) => {
    const source = useContext(Source);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const closed = start === undefined || end === undefined || isCodeFenceClosed(source.slice(start, end));
    const m = /language-([\w+-]+)/.exec(className ?? '');
    const text = String(children ?? '');
    const isBlock = Boolean(m) || text.includes('\n');
    if (!isBlock) return <code {...rest}>{children}</code>;
    const lang = m?.[1]?.toLowerCase();
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} closed={closed} title={lang ? undefined : 'text'} className="my-3" />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ImageLink,
  table: ({ children }) => <table>{children}</table>,
};

/** While streaming, re-parse at most this often; deltas usually arrive faster than this. */
const STREAM_PARSE_MS = 45;

/**
 * The text a streaming markdown render should parse: the latest text, but
 * re-parsed at most every `ms` while streaming (a full remark parse per delta
 * dominated streaming renders). The moment streaming ends the final text
 * returns as-is, so it renders at once.
 */
export function useThrottledText(text: string, streaming: boolean | undefined, ms = STREAM_PARSE_MS): string {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!streaming) {
      setShown((s) => (s === latest.current ? s : latest.current));
      return;
    }
    const iv = setInterval(() => setShown((s) => (s === latest.current ? s : latest.current)), ms);
    return () => clearInterval(iv);
  }, [streaming, ms]);
  return streaming ? shown : text;
}

/** Assistant prose: markdown at the reading size and measure (index.css .md), code in boxes, a static caret while streaming. */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  const shown = useThrottledText(text, streaming);
  const markdown = useMemo(() => <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{shown}</ReactMarkdown>, [shown]);
  return (
    <Source.Provider value={shown}>
      <div className={cn('md', streaming && 'md-streaming', className)}>{markdown}</div>
    </Source.Provider>
  );
});

/**
 * Markdown that streams: new characters come up from dim per chunk
 * (CHAT-AND-MOTION 1.6). A block that was already finished when it mounted
 * (a reply from before, a reload) gets no reveal at all.
 */
export function StreamedMarkdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  const [wasLive] = useState(!!streaming);
  if (!wasLive) return <Markdown text={text} streaming={streaming} className={className} />;
  return (
    <InkReveal active={!!streaming}>
      <Markdown text={text} streaming={streaming} className={className} />
    </InkReveal>
  );
}
