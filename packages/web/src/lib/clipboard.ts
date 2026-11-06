/**
 * Text to the clipboard, for every copy button.
 *
 * navigator.clipboard is missing over plain http on a LAN address and often
 * missing or refused in WebKitGTK (the Linux desktop app). So: the async API,
 * else a hidden textarea and execCommand('copy'), else (desktop app) the app
 * copies (desktop main.rs copy_text). False when nothing copied, so the
 * button never says Copied for nothing.
 */
import { desktop } from '@/overlay/desktop';

export const COPY_FAILED = 'Could not copy. Select the text and press Ctrl+C.';

export async function copyText(text: string): Promise<boolean> {
  // without the API the fallback runs before any await, still inside the click
  const clip = globalThis.navigator?.clipboard;
  if (clip?.writeText && (await clip.writeText(text).then(() => true, () => false))) return true;
  if (execCopy(text)) return true;
  const app = desktop();
  return app ? app.invoke('copy_text', { text }).then(() => true, () => false) : false;
}

/** execCommand('copy') from a hidden textarea; focus and selection are put back after. */
function execCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || !document.execCommand) return false;
  const active = document.activeElement as HTMLElement | null;
  const sel = document.getSelection?.();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  // inside an open dialog: its focus trap would pull focus back out of a textarea on body
  (active?.closest?.('[role="dialog"]') ?? document.body).appendChild(box);
  let ok = false;
  try {
    box.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  box.remove();
  active?.focus?.({ preventScroll: true });
  if (sel) {
    sel.removeAllRanges();
    for (const r of ranges) sel.addRange(r);
  }
  return ok;
}
