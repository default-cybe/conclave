import { memo, useState } from 'react';
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

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const m = /language-([\w+-]+)/.exec(className ?? '');
    const text = String(children ?? '');
    const isBlock = Boolean(m) || text.includes('\n');
    if (!isBlock) return <code {...rest}>{children}</code>;
    const lang = m?.[1]?.toLowerCase();
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} title={lang ? undefined : 'text'} className="my-3" />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ImageLink,
  table: ({ children }) => <table>{children}</table>,
};

/** Assistant prose: markdown at the reading size and measure (index.css .md), code in boxes, a static caret while streaming. */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cn('md', streaming && 'md-streaming', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
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
