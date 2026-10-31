/**
 * Entry of overlay.html, the meeting overlay window (docs/design/MEETING-MODE.md
 * 3.4): <hub>/overlay.html?meeting=<id>#token=<token>. Its own small bundle:
 * no app store, no Tailwind, no app styles. With no meeting it opens on the
 * setup screen. VITE_MOCK=1 runs it on the mock hub and a fake desktop.
 */
import './overlay.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchReq } from './hub';
import { Overlay, type Conn } from './Overlay';

const MOCK = import.meta.env.VITE_MOCK === '1';
const TOKEN_KEY = 'conclave.overlay.token';

/** #token= once, kept for this window's reloads in sessionStorage only, then stripped from the address. */
function takeToken(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const t = hash.get('token');
  if (t) {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* no storage: this load only */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return t;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function boot() {
  // the overlay never shows a native context menu: it would be a separate window that screen sharing captures (7.2)
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  const baseUrl = location.origin;
  let token = takeToken();
  let conn: Conn;
  if (MOCK) {
    const mock = await import('../mock');
    const meetings = await import('../mock/meetings');
    token ??= 'mock';
    const req = fetchReq(baseUrl, token, mock.mockFetch);
    meetings.installMockDesktop(req);
    conn = { req, baseUrl, token, WebSocketImpl: mock.MockWebSocket as unknown as typeof WebSocket };
  } else conn = { req: fetchReq(baseUrl, token ?? ''), baseUrl, token: token ?? '' };
  const meetingId = new URLSearchParams(location.search).get('meeting') ?? undefined;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Overlay conn={conn} meetingId={meetingId} signedIn={!!token} />
    </StrictMode>,
  );
}

void boot();
