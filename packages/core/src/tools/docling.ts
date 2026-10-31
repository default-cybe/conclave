import type { ToolContext } from './types';

/** File types docling-serve converts (it has no OpenDocument reader). */
export const DOCLING_EXT = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The Docling server this session may send files to, or undefined. Every
 * account uses it: docling-serve's /v1/convert/file is stateless (bytes in,
 * markdown back, nothing written or kept per caller), and the address is the
 * owner's config, never one a member picks.
 */
export function doclingFor(ctx: ToolContext): { url: string; timeoutMs: number } | undefined {
  const d = ctx.host.config().documents?.docling;
  if (!d?.url) return undefined;
  let u: URL;
  try {
    u = new URL(d.url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const base = u.href.replace(/\/+$/, '');
  return { url: base.endsWith('/v1/convert/file') ? base : `${base}/v1/convert/file`, timeoutMs: d.timeoutMs && d.timeoutMs > 0 ? d.timeoutMs : DEFAULT_TIMEOUT_MS };
}

/** Markdown of a document from docling-serve's POST /v1/convert/file. Throws on any failure, so the caller falls back. */
export async function doclingConvert(
  cfg: { url: string; timeoutMs: number },
  bytes: Uint8Array,
  name: string,
  opts: { pages?: [number, number]; signal?: AbortSignal } = {},
): Promise<string> {
  const form = new FormData();
  form.append('files', new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
  form.append('to_formats', 'md');
  form.append('image_export_mode', 'placeholder');
  if (opts.pages) for (const p of opts.pages) form.append('page_range', String(p));
  const signals = [AbortSignal.timeout(cfg.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
  const res = await fetch(cfg.url, { method: 'POST', body: form, signal: AbortSignal.any(signals) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
  const body = (await res.json()) as { status?: string; document?: { md_content?: string }; errors?: unknown[] };
  const md = body.document?.md_content;
  if ((body.status !== 'success' && body.status !== 'partial_success') || typeof md !== 'string' || !md.trim()) {
    throw new Error(`conversion ${body.status ?? 'failed'}${body.errors?.length ? `: ${JSON.stringify(body.errors).slice(0, 200)}` : ''}`);
  }
  return md;
}
