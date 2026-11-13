/**
 * The desktop app asks for attention while an approval or a question waits on
 * you (desktop main.rs attention): the Dock bounces on macOS, the taskbar
 * button flashes on Windows and Linux, and the waiting count sits on the app's
 * badge (macOS, Linux). It fires when a new one arrives while the window is
 * not in front, and stops when you come back or nothing waits any more. The
 * same switch as its notification turns it off: Settings > Notifications,
 * Approvals and questions.
 */
import { desktop } from '@/overlay/desktop';
import { appInUse, QUICK_WINDOW } from './notify';

interface Waiting {
  approvals: Record<string, unknown>;
  questions: Record<string, unknown>;
  config?: Record<string, unknown>;
}

interface Store {
  getState: () => Waiting;
  subscribe: (fn: (s: Waiting) => void) => () => void;
}

const enabled = (s: Waiting) => (s.config?.notifications as { on?: { approvalNeeded?: boolean } } | undefined)?.on?.approvalNeeded !== false;

/** Ids already asked for (or seen in front): a focus and blur, or a reconnect, never fires again for them. */
const seen = new Set<string>();
/** Attention was asked for and not stopped yet (also across a reconnect). */
let flashing = false;
/** The last `on count` sent, so only a change goes to the app. */
let sent = '';

/** Starts following `store`. Returns a function that stops. Nothing happens outside the desktop app. */
export function watchAttention(store: Store): () => void {
  const app = desktop();
  // the quick ask window runs the app too; the main window asks for attention
  if (!app || QUICK_WINDOW) return () => undefined;
  /** `ask`: a new arrival, sent even when nothing else changed. */
  const send = (on: boolean, count: number, ask = false) => {
    flashing = on;
    const key = `${on} ${count}`;
    if (key === sent && !ask) return;
    sent = key;
    void app.invoke('attention', { on, count }).catch(() => undefined);
  };
  const update = (s: Waiting, focused = appInUse()) => {
    const ids = [...Object.keys(s.approvals), ...Object.keys(s.questions)];
    const fresh = ids.some((id) => !seen.has(id));
    // add-only: a list that is empty for a moment (a reload, a failed fetch) must not make them new again
    for (const id of ids) seen.add(id);
    if (!ids.length || !enabled(s)) send(false, 0);
    else if (focused) send(false, ids.length);
    else if (fresh) send(true, ids.length, true);
    // a count change while away: the badge follows, a running bounce keeps going
    else send(flashing, ids.length);
  };
  const unsubscribe = store.subscribe((s) => update(s));
  const onFocus = () => update(store.getState(), true);
  window.addEventListener('focus', onFocus);
  update(store.getState());
  return () => {
    unsubscribe();
    window.removeEventListener('focus', onFocus);
  };
}
