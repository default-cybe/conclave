/**
 * A fake marketplace on 127.0.0.1 for watch tests and the scratch runs: a
 * search page of listings that the test changes between runs (added,
 * removed, sold, price changed), an item page per listing with "Message
 * seller" (a form POST), "Buy now" (a fetch POST), a beacon and a
 * WebSocket on load, a photo per listing, and an optional login wall
 * (a cookie from POST /login). Every request other than GET is recorded,
 * so a test can prove a watch run sent nothing.
 *
 * It also holds the scripted "model" that drives a watch the way a real
 * one would: it reads the browser tools' results out of the conversation
 * and decides the next call (marketStep).
 */
export interface Listing {
  id: string;
  title: string;
  price: number;
  location: string;
  status?: 'available' | 'pending' | 'sold';
  year?: string;
  mileage?: string;
}

export interface FakeMarket {
  url: string;
  listings: Listing[];
  /** Removed from the site: the item page says it is not available. */
  removed: Set<string>;
  /** Requests that were not GET, HEAD or OPTIONS. */
  posts: Array<{ method: string; path: string }>;
  /** WebSocket upgrades that reached the server. */
  sockets: number;
  /** Search page loads, with whether the login cookie came along. */
  searches: Array<{ loggedIn: boolean }>;
  requireLogin: boolean;
  set(list: Listing[]): void;
  stop(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export const CARS: Listing[] = [
  { id: '101', title: '2014 Honda Civic LX', price: 6500, location: 'Oakland, CA', year: '2014', mileage: '98,000 mi' },
  { id: '102', title: '2012 Toyota Corolla LE', price: 6400, location: 'Berkeley, CA', year: '2012', mileage: '121,000 mi' },
  { id: '103', title: '2010 Honda Fit Sport', price: 4800, location: 'Alameda, CA', year: '2010', mileage: '140,000 mi' },
  { id: '104', title: '2013 Mazda3 i Touring', price: 7200, location: 'San Leandro, CA', year: '2013', mileage: '110,000 mi' },
];

const COLORS = ['#3a6ea5', '#a53a3a', '#3aa56e', '#a58a3a', '#6e3aa5', '#3a9aa5'];

function photo(id: string, title: string): string {
  const c = COLORS[Number(id) % COLORS.length] ?? COLORS[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="${c}"/><rect x="60" y="120" width="200" height="50" rx="14" fill="#fff" opacity=".85"/><rect x="95" y="88" width="120" height="40" rx="12" fill="#fff" opacity=".7"/><circle cx="105" cy="172" r="18" fill="#222"/><circle cx="215" cy="172" r="18" fill="#222"/><text x="16" y="34" font-family="sans-serif" font-size="22" fill="#fff">${esc(title.split(' ').slice(0, 3).join(' '))}</text></svg>`;
}

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:sans-serif;margin:24px}a.card{display:inline-block;width:200px;margin:8px;vertical-align:top;color:#111;text-decoration:none}a.card img{width:200px;height:150px;display:block}.price{font-weight:bold;display:block}.loc{color:#666;display:block}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

export function startFakeMarket(opts: { requireLogin?: boolean; listings?: Listing[] } = {}): FakeMarket {
  const market: FakeMarket = {
    url: '',
    listings: (opts.listings ?? CARS).map((l) => ({ ...l })),
    removed: new Set(),
    posts: [],
    sockets: 0,
    searches: [],
    requireLogin: !!opts.requireLogin,
    set(list) {
      this.listings = list.map((l) => ({ ...l }));
    },
    stop() {
      server.stop(true);
    },
  };
  const loggedIn = (req: Request) => /(?:^|;\s*)mk_session=ok/.test(req.headers.get('cookie') ?? '');
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        market.posts.push({ method: req.method, path });
        if (path === '/login') {
          return html(page('Signed in', '<h1>You are signed in</h1><a href="/marketplace/search?query=cars">Go to Marketplace</a>'), 200, { 'set-cookie': 'mk_session=ok; Path=/; Max-Age=31536000; HttpOnly' });
        }
        return html(page('Sent', '<h1>Message sent</h1>'));
      }
      if (path === '/ws') {
        market.sockets++;
        if (srv.upgrade(req)) return undefined;
        return new Response('no', { status: 400 });
      }
      if (path === '/login') {
        return html(page('Log in', '<h1>Log in to Marketplace</h1><form method="post" action="/login"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>'));
      }
      const img = /^\/img\/(\w+)\.svg$/.exec(path);
      if (img) {
        const l = market.listings.find((x) => x.id === img[1]);
        return new Response(photo(img[1], l?.title ?? 'Car'), { headers: { 'content-type': 'image/svg+xml' } });
      }
      if (path === '/marketplace/search') {
        market.searches.push({ loggedIn: loggedIn(req) });
        if (market.requireLogin && !loggedIn(req)) return html(page('Log in', '<h1>Log in to see Marketplace</h1><a href="/login">Log in</a>'));
        const q = (url.searchParams.get('query') ?? '').toLowerCase();
        const max = Number(url.searchParams.get('maxPrice') ?? Infinity);
        const shown = market.listings.filter((l) => !market.removed.has(l.id) && l.status !== 'sold' && l.price <= max && (!q || q === 'cars' || l.title.toLowerCase().includes(q)));
        const cards = shown
          .map((l) => `<a class="card" href="/marketplace/item/${l.id}/"><img src="${market.url}/img/${l.id}.svg" alt="${esc(l.title)}"><span class="price">${money(l.price)}</span><span class="title">${esc(l.title)}</span><span class="loc">${esc(l.location)}</span></a>`)
          .join('');
        return html(page(`Marketplace: ${q || 'all'}`, `<h1>Marketplace</h1><p>${shown.length} results</p><div>${cards}</div><a href="/help">Help</a>`));
      }
      const item = /^\/marketplace\/item\/(\w+)\/?$/.exec(path);
      if (item) {
        const l = market.listings.find((x) => x.id === item[1]);
        if (!l || market.removed.has(l.id)) return html(page('Not available', "<h1>This listing isn't available anymore</h1>"), 404);
        const status = l.status === 'sold' ? '<p class="status">Sold</p>' : l.status === 'pending' ? '<p class="status">Pending</p>' : '';
        const facts = [l.year ? `<li>Year: ${l.year}</li>` : '', l.mileage ? `<li>Mileage: ${esc(l.mileage)}</li>` : ''].join('');
        // what a real page does on load: a beacon and a live connection
        const script = `try{navigator.sendBeacon('/beacon','seen ${l.id}')}catch(e){};try{new WebSocket('ws://'+location.host+'/ws')}catch(e){};document.getElementById('buy').onclick=function(){fetch('/checkout',{method:'POST',body:'${l.id}'})}`;
        return html(
          page(
            l.title,
            `<h1>${esc(l.title)}</h1><p class="price">${money(l.price)}</p>${status}<p class="loc">${esc(l.location)}</p><ul>${facts}</ul><img src="${market.url}/img/${l.id}.svg" alt="${esc(l.title)}"><form method="post" action="/marketplace/item/${l.id}/message"><textarea name="text">Is this still available?</textarea><button type="submit">Message seller</button></form><button id="buy" type="button">Buy now</button>`,
            script,
          ),
        );
      }
      return html(page('Not found', '<h1>Not found</h1>'), 404);
    },
    websocket: { message() {}, open() {} },
  });
  market.url = `http://127.0.0.1:${server.port}`;
  return market;
}

// ---------------------------------------------------------------------------
// The scripted model: reads the conversation, picks the next call
// ---------------------------------------------------------------------------

type Block = { text: string } | { tool: string; input: Record<string, unknown> };
type Msg = { role: string; content: string | Array<Record<string, any>> };

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : typeof b?.content === 'string' ? b.content : textOf(b?.content))).join('\n');
  return '';
}

/** Items in browser_links' lines: "- url | $6,500 | 2014 Honda Civic LX | Oakland, CA | image: src". */
export function itemsFromLinks(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const m = /^- (https?:\/\/\S+\/item\/(\w+)\/?) \| (.*)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[3].split(' | ');
    const image = parts.find((p) => p.startsWith('image: '))?.slice(7);
    const words = parts.filter((p) => !p.startsWith('image: '));
    const price = words.find((p) => /^\$[\d,]+$/.test(p));
    const rest = words.filter((p) => p !== price);
    out.push({ id: m[2], url: m[1], title: rest[0] ?? '', ...(price ? { price } : {}), ...(rest[1] ? { location: rest[1] } : {}), ...(image ? { image } : {}) });
  }
  return out;
}

/** One item from its page's snapshot: gone, sold, pending or available with its price and facts. */
export function itemFromPage(id: string, url: string, text: string): Record<string, unknown> {
  if (/isn't available anymore|HTTP 404/.test(text)) return { id, url, status: 'gone' };
  const title = /heading "([^"]+)" \[level=1\]/.exec(text)?.[1] ?? '';
  const price = /\$[\d,]+/.exec(text)?.[0];
  const status = /\bSold\b/.test(text) ? 'sold' : /\bPending\b/.test(text) ? 'pending' : 'available';
  const year = /Year: (\d{4})/.exec(text)?.[1];
  const mileage = /Mileage: ([\d,]+ mi)/.exec(text)?.[1];
  return { id, url, title, ...(price ? { price } : {}), status, fields: { ...(year ? { year } : {}), ...(mileage ? { mileage } : {}) } };
}

export interface MarketScript {
  /** The search address a chat starts at. */
  search: string;
}

/**
 * The next reply for a conversation about the fake market. A chat searches,
 * reports and offers a watch; "yes" makes the watch; a watch run (its first
 * message has the hub's data block) searches, reports, then checks each item
 * WatchReport says it has not reported yet by opening its link.
 */
export function marketStep(messages: Msg[], s: MarketScript): Block[] {
  const first = textOf(messages.find((m) => m.role === 'user')?.content);
  const run = /Start at: (\S+)/.exec(first)?.[1];
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  const call = Array.isArray(prev?.content) ? [...prev.content].reverse().find((b) => b.type === 'tool_use') : undefined;
  const result = Array.isArray(last?.content) ? last.content.find((b) => b.type === 'tool_result') : undefined;
  const out = textOf(result?.content);
  const asked = last?.role === 'user' && !result ? textOf(last.content) : '';

  if (asked && /watch this|yes/i.test(asked) && messages.length > 1) {
    return [
      {
        tool: 'WatchCreate',
        input: {
          name: 'Cars under $8,000',
          schedule: '0 9 * * *',
          url: s.search,
          prompt: 'Find used cars under $8,000 on the marketplace search page: Honda, Toyota or Mazda, 2010 or newer. Read the price, place, year and mileage of each listing.',
          fields: ['year', 'mileage'],
          filters: { maxPrice: 8000, keywords: ['honda', 'toyota', 'mazda'], exclude: ['salvage', 'parts'] },
          currency: 'USD',
        },
      },
    ];
  }
  if (!call) return [{ text: 'Looking at the marketplace.' }, { tool: 'browser_navigate', input: { url: run ?? s.search } }];
  switch (call.name) {
    case 'browser_navigate': {
      const target = String(call.input?.url ?? '');
      const item = /\/item\/(\w+)\/?/.exec(target);
      if (item) return [{ tool: 'WatchReport', input: { items: [itemFromPage(item[1], target, out)] } }];
      return [{ tool: 'browser_links', input: { match: '/marketplace/item/' } }];
    }
    case 'browser_links':
      return [{ tool: 'WatchReport', input: { items: itemsFromLinks(out), source: run ?? s.search } }];
    case 'WatchReport': {
      if (!run) return [{ text: 'These are the cars under $8,000 near Oakland right now. Watch this daily?' }];
      const left = /Not reported yet[^\n]*\n((?:- .*\n?)+)/.exec(out)?.[1];
      const next = left?.split('\n').map((l) => /^- (\w+) \| .* \| (https?:\/\/\S+)$/.exec(l.trim())).find(Boolean);
      if (next) return [{ tool: 'browser_navigate', input: { url: next[2] } }];
      return [{ text: 'Done. The hub compares the items.' }];
    }
    case 'WatchCreate':
      return [{ text: 'Done. I will check every morning at 09:00 and tell you only when something changes.' }];
    default:
      return [{ text: 'Done.' }];
  }
}
