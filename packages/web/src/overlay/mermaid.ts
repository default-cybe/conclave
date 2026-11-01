/**
 * A ```mermaid fence drawn as a diagram. Loaded with import() on the first
 * such fence, so mermaid is its own chunk and never in the overlay's entry.
 * securityLevel "strict" makes mermaid escape labels and run its output
 * through DOMPurify, so the SVG it returns carries no script.
 */
let ready: Promise<typeof import('mermaid').default> | undefined;
let n = 0;

export async function renderMermaid(src: string): Promise<string> {
  ready ??= import('mermaid').then((m) => m.default);
  const mermaid = await ready;
  const dark = document.documentElement.dataset.theme !== 'light';
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit', fontSize: 12 });
  const { svg } = await mermaid.render(`ov-mermaid-${++n}`, src);
  return svg;
}
