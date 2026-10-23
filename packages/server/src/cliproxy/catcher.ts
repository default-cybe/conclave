/**
 * Same-computer sign-in. Claude, ChatGPT and Google end their sign-in by
 * sending the browser to a localhost address (http://localhost:54545/callback
 * for Claude). When the browser runs on the hub's own computer the hub
 * listens there for the length of the sign-in, on 127.0.0.1 and ::1 only,
 * and hands the address to CLIProxyAPI as if it had been pasted. Nothing
 * listens on the network, and only the one path with the session's state is
 * taken.
 */
import { esc, htmlPage } from '../static';

export interface Catcher {
  stop(): void;
}

export interface CatchOptions {
  port: number;
  /** The redirect path ("/callback"). */
  path: string;
  /** The session state the redirect must carry. */
  state: string;
  /** Give CLIProxyAPI the full address; resolve with the words for the page the browser shows. */
  onHit: (url: string) => Promise<{ ok: boolean; message: string }>;
}

function page(title: string, body: string, ok: boolean): Response {
  const res = htmlPage(title, `<p>${esc(body)}</p>`, ok ? 200 : 400);
  // nothing but this page is served here
  res.headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  return res;
}

/** Listen on the redirect port. Undefined when the port is taken (the page then asks for the address instead). */
export function catchRedirect(opts: CatchOptions): Catcher | undefined {
  let used = false;
  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.pathname !== opts.path) return new Response('not found', { status: 404 });
    if (url.searchParams.get('state') !== opts.state) return page('This is not the sign-in Conclave started', 'Go back to Conclave and start the sign-in again.', false);
    if (used) return page('Already done', 'This sign-in already reached the hub. You can close this tab.', true);
    used = true;
    // what the browser asked for, with the host it used, as CLIProxyAPI expects in redirect_url
    const full = `http://${req.headers.get('host') ?? `localhost:${opts.port}`}${url.pathname}${url.search}`;
    const r = await opts.onHit(full).catch((err) => ({ ok: false, message: (err as Error).message }));
    if (!r.ok) used = false;
    return page(r.ok ? 'Signed in' : 'The sign-in did not finish', r.message, r.ok);
  };
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  // 127.0.0.1 is the one every browser tries; without it the page asks for the address
  try {
    servers.push(Bun.serve({ hostname: '127.0.0.1', port: opts.port, fetch: fetchHandler, development: false }));
  } catch {
    return undefined;
  }
  try {
    servers.push(Bun.serve({ hostname: '::1', port: opts.port, fetch: fetchHandler, development: false }));
  } catch {
    /* taken there, or this machine has no IPv6 loopback */
  }
  return {
    stop() {
      // often called while the browser's request is still being answered: stop taking new ones, let that one finish
      const list = servers.splice(0);
      for (const s of list) {
        try {
          s.stop(false);
        } catch {
          /* already stopped */
        }
      }
      const t = setTimeout(() => {
        for (const s of list) {
          try {
            s.stop(true);
          } catch {
            /* already stopped */
          }
        }
      }, 3_000);
      (t as { unref?: () => void }).unref?.();
    },
  };
}
