/**
 * The desktop app moves its hidden window to Home and back inside the page
 * (desktop/src-tauri/src/main.rs, in_page_navigate) instead of loading it
 * again: a full load looked like the app restarting by itself.
 */
export const DESKTOP_NAVIGATE = 'conclave:navigate';

/** Calls `go` with the path of each event; anything but a path on this hub is ignored. */
export function listenDesktopNavigate(target: EventTarget, go: (to: string) => void): () => void {
  const on = (e: Event) => {
    const to = (e as CustomEvent<unknown>).detail;
    if (typeof to === 'string' && to.startsWith('/') && !to.startsWith('//')) go(to);
  };
  target.addEventListener(DESKTOP_NAVIGATE, on);
  return () => target.removeEventListener(DESKTOP_NAVIGATE, on);
}
