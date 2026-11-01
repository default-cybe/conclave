/*
 * Incremental streaming markdown for the overlay.
 *
 * Ported from Pickle Glass, github.com/SerzhIvanov/glass (a fork of
 * pickle-com/glass) @71bc3dce7c92c31ffd0e68eb708f55b171f52a96:
 *   src/ui/ask/AskView.js 1023-1075 (renderStreamingMarkdown: one smd parser
 *     per answer, parser_write of only the new slice, parser_end when done,
 *     highlight each closed code block once behind a data-highlighted guard)
 *   src/ui/ask/AskView.js 1204-1270 (copy with a "Copied" state for 1.5 s)
 * Copyright (C) 2025 Pickle Team. Licensed GPL-3.0-or-later; combined into
 * Conclave (AGPL-3.0-only) under GPLv3 section 13.
 *
 * Changed from the source: a React component instead of a LitElement, and a
 * safe renderer instead of smd's default_renderer: no raw HTML ever (smd
 * gives text, and text goes in as text nodes), links only http(s) and mailto
 * with rel=noopener and opened in the system browser, images become links.
 */
import { useLayoutEffect, useRef } from 'react';
import * as smd from './smd';
import { chartSvg, parseChart } from './chart';
import { desktop } from './desktop';

type Hooks = { onCode?: (box: HTMLElement, code: HTMLElement, lang: string) => void };

/** http, https and mailto only; anything else (javascript:, data:, relative) has no href. */
export function safeHref(u: string): string | undefined {
  try {
    const x = new URL(u.trim());
    return x.protocol === 'http:' || x.protocol === 'https:' || x.protocol === 'mailto:' ? x.href : undefined;
  } catch {
    return undefined;
  }
}

const TAG: Record<number, string> = {
  [smd.BLOCKQUOTE]: 'blockquote',
  [smd.PARAGRAPH]: 'p',
  [smd.LINE_BREAK]: 'br',
  [smd.RULE]: 'hr',
  [smd.HEADING_1]: 'h3',
  [smd.HEADING_2]: 'h3',
  [smd.HEADING_3]: 'h4',
  [smd.HEADING_4]: 'h4',
  [smd.HEADING_5]: 'h4',
  [smd.HEADING_6]: 'h4',
  [smd.ITALIC_AST]: 'em',
  [smd.ITALIC_UND]: 'em',
  [smd.STRONG_AST]: 'strong',
  [smd.STRONG_UND]: 'strong',
  [smd.STRIKE]: 's',
  [smd.CODE_INLINE]: 'code',
  [smd.LINK]: 'a',
  [smd.RAW_URL]: 'a',
  [smd.IMAGE]: 'a',
  [smd.LIST_UNORDERED]: 'ul',
  [smd.LIST_ORDERED]: 'ol',
  [smd.LIST_ITEM]: 'li',
  [smd.TABLE_ROW]: 'tr',
  [smd.EQUATION_BLOCK]: 'pre',
  [smd.EQUATION_INLINE]: 'code',
};

/** smd's renderer interface over the DOM, writing only elements, text nodes and checked attributes. */
function safeRenderer(root: HTMLElement, hooks: Hooks) {
  const nodes: HTMLElement[] = [root];
  const types: number[] = [smd.DOCUMENT];
  const el = (t: string) => root.ownerDocument.createElement(t);
  return {
    data: undefined,
    add_token(_: unknown, type: number) {
      if (type === smd.DOCUMENT) return;
      let parent: HTMLElement = nodes[nodes.length - 1]!;
      let slot: HTMLElement;
      if (type === smd.CODE_FENCE || type === smd.CODE_BLOCK) {
        // the head is there from the first line, so closing the fence moves nothing
        const box = parent.appendChild(el('div'));
        box.className = 'ov-code';
        const head = box.appendChild(el('div'));
        head.className = 'ov-code-head';
        head.appendChild(el('span')).textContent = 'code';
        parent = box.appendChild(el('pre'));
        slot = el('code');
        const code = slot;
        head.appendChild(copyButton(root.ownerDocument, () => code.textContent ?? ''));
      } else if (type === smd.TABLE) {
        const wrap = parent.appendChild(el('div'));
        wrap.className = 'ov-table';
        slot = el('table');
        parent = wrap;
      } else if (type === smd.TABLE_ROW) {
        const n = parent.children.length;
        parent = n === 0 ? parent.appendChild(el('thead')) : n === 1 ? parent.appendChild(el('tbody')) : (parent.children[1] as HTMLElement);
        slot = el('tr');
      } else if (type === smd.TABLE_CELL) {
        slot = el(parent.parentElement?.tagName === 'THEAD' ? 'th' : 'td');
      } else if (type === smd.CHECKBOX) {
        const box = el('input') as HTMLInputElement;
        box.type = 'checkbox';
        box.disabled = true;
        slot = box;
      } else slot = el(TAG[type] ?? 'span');
      if (type === smd.IMAGE) slot.className = 'ov-img';
      nodes.push(parent.appendChild(slot));
      types.push(type);
    },
    end_token() {
      const node = nodes.pop()!;
      const type = types.pop();
      if (type === smd.IMAGE && !node.textContent) node.textContent = 'image';
      if ((type === smd.CODE_FENCE || type === smd.CODE_BLOCK) && hooks.onCode) hooks.onCode(node.parentElement!.parentElement!, node, node.dataset.lang ?? '');
    },
    add_text(_: unknown, text: string) {
      nodes[nodes.length - 1]!.appendChild(root.ownerDocument.createTextNode(text));
    },
    set_attr(_: unknown, type: number, value: string) {
      const node = nodes[nodes.length - 1]!;
      if (type === smd.HREF || type === smd.SRC) {
        const href = safeHref(value);
        if (href) {
          node.setAttribute('href', href);
          node.setAttribute('rel', 'noopener noreferrer');
          node.setAttribute('target', '_blank');
        }
      } else if (type === smd.LANG) {
        node.dataset.lang = value.trim().toLowerCase().replace(/[^\w+#.-]/g, '').slice(0, 24);
        const label = node.parentElement?.previousElementSibling?.firstElementChild;
        if (label && node.dataset.lang) label.textContent = node.dataset.lang;
      }
      else if (type === smd.CHECKED) (node as HTMLInputElement).checked = true;
      else if (type === smd.START && /^\d{1,6}$/.test(value)) node.setAttribute('start', value);
    },
  };
}

export interface MdStream {
  /** Feed the whole text so far; only what is new since the last call is parsed. False when the text is not a continuation. */
  write(text: string): boolean;
  end(): void;
}

/** One parser for one text: Glass's renderStreamingMarkdown without the component around it. */
export function mdStream(root: HTMLElement, hooks: Hooks = { onCode: enhanceCode }): MdStream {
  const p = smd.parser(safeRenderer(root, hooks));
  let written = '';
  let ended = false;
  return {
    write(text) {
      if (!text.startsWith(written)) return false;
      const fresh = text.slice(written.length);
      if (fresh && !ended) smd.parser_write(p, fresh);
      written = text;
      return true;
    },
    end() {
      if (ended) return;
      ended = true;
      smd.parser_end(p);
    },
  };
}

/** Copy with Glass's 1.5 s "Copied" state, on a plain button. */
export function copyButton(doc: Document, text: () => string, label = 'Copy'): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'ov-copy';
  b.textContent = label;
  let t: ReturnType<typeof setTimeout> | undefined;
  b.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text()).then(
      () => {
        b.textContent = 'Copied';
        clearTimeout(t);
        t = setTimeout(() => (b.textContent = label), 1500);
      },
      () => undefined,
    );
  });
  return b;
}

let hl: Promise<typeof import('@/lib/highlight')> | undefined;

/** A closed fence: a chart, a diagram, or highlighted code. */
export function enhanceCode(box: HTMLElement, code: HTMLElement, lang: string): void {
  const doc = box.ownerDocument;
  const src = code.textContent ?? '';
  if (lang === 'chart') {
    const spec = parseChart(src);
    if (!spec) return;
    const fig = doc.createElement('figure');
    fig.className = 'ov-chart';
    fig.innerHTML = chartSvg(spec); // every string in it is escaped (chart.ts)
    box.replaceWith(fig);
    return;
  }
  if (lang === 'mermaid') {
    void import('./mermaid')
      .then((m) => m.renderMermaid(src))
      .then((svg) => {
        const fig = doc.createElement('figure');
        fig.className = 'ov-diagram';
        fig.innerHTML = svg; // mermaid's strict mode: escaped labels, DOMPurify on the output
        box.replaceWith(fig);
      })
      .catch(() => undefined); // not a diagram: the code block stays
    return;
  }
  if (code.dataset.highlighted) return;
  code.dataset.highlighted = 'true';
  hl ??= import('@/lib/highlight');
  void hl.then((h) => {
    const html = h.highlight(src, lang); // hljs escapes the code; null for an unknown language
    if (html !== null && code.isConnected) {
      code.innerHTML = html;
      code.classList.add('hljs');
    }
  });
}

/** Links leave the overlay for the system browser: the desktop's navigation guard opens them (main.rs allow_navigation). */
function openLink(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  if (desktop()) location.assign(a.href);
  else window.open(a.href, '_blank', 'noopener,noreferrer');
}

/**
 * Markdown that grows while it streams. One parser per mount: key it by the
 * answer id. Each render writes only the new slice, so a frame's deltas
 * (frame.ts) cost one parser_write; a text that is not a continuation starts over.
 */
export function StreamText({ text, done, className }: { text: string; done: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stream = useRef<MdStream | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!stream.current?.write(text)) {
      el.replaceChildren();
      stream.current = mdStream(el);
      stream.current.write(text);
    }
    if (done) stream.current.end();
  }, [text, done]);
  return <div ref={ref} className={className} onClick={openLink} />;
}
