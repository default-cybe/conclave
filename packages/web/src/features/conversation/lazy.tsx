/**
 * The Chat page as a route that loads on demand, like React.lazy, but
 * renders at once when its code is already here. React.lazy suspends on its
 * first render even then, and a route change that suspends blanks the page
 * (React holds the empty fallback for up to 300ms). Home preloads the page,
 * so sending from Home opens the chat with the message already on screen.
 *
 * A fetch that fails (offline, or a new version of the app replaced the
 * file) shows a line and Reload, instead of a blank page that keeps
 * fetching. Browsers remember a failed import for the page's life, so only
 * a reload fetches it again.
 */
import { use } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';

type ChatModule = typeof import('./ChatPage');
type Loaded = { page: ChatModule['default'] } | { error: unknown };
/** A promise that says whether it settled, the way React's use() reads it, so a loaded page does not suspend. */
type Tracked = Promise<Loaded> & { status?: 'fulfilled' | 'rejected'; value?: Loaded; reason?: unknown };

let loading: Tracked | undefined;

function load(): Tracked {
  // never rejects: a failure is a value, so the route can show it once instead of suspending again
  const p: Tracked = import('./ChatPage').then(
    (m): Loaded => ({ page: m.default }),
    (error: unknown): Loaded => ({ error }),
  );
  p.then((v) => {
    p.status = 'fulfilled';
    p.value = v;
  });
  loading = p;
  return p;
}

const failed = (p: Tracked | undefined) => !!p?.value && 'error' in p.value;

/** Fetch the Chat page's code ahead of time. Safe to call often. */
export function preloadChatPage(): Promise<Loaded> {
  return !loading || failed(loading) ? load() : loading;
}

export function ChatPageRoute() {
  // a failed fetch stays failed here: retrying on every render would never settle
  const pending: Promise<Loaded> = loading ?? load();
  const got = use(pending);
  if ('page' in got) return <got.page />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[784px] px-8 pt-16 phone:px-4">
        <EmptyState wave={false} action={{ label: 'Reload', onClick: () => location.reload() }}>
          The chat page did not load. Check that this device is online, then reload. Your chat is saved on the hub.
        </EmptyState>
      </div>
    </div>
  );
}
