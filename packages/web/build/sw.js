/* Conclave service worker. Built by build/pwa.ts, which fills in the precache list. */
/* eslint-disable no-restricted-globals */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `conclave-${VERSION}`;
const NETWORK_ONLY = ['/api', '/gw', '/v1'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('conclave-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;

  if (req.mode === 'navigate') {
    // network first so a new deploy shows up, app shell when offline
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Conclave', body: event.data ? event.data.text() : '' };
  }
  const notice = data.notice || data;
  const actions = notice.approvalId
    ? [
        { action: 'allow', title: 'Allow' },
        { action: 'deny', title: 'Deny' },
      ]
    : [];
  event.waitUntil(
    self.registration.showNotification(notice.title || 'Conclave', {
      body: notice.body || '',
      tag: notice.tag || notice.approvalId || notice.id || undefined,
      // a job's notice replaces the last one in place; renotify so the update still alerts
      renotify: String(notice.tag || '').startsWith('thread-'),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: notice,
      actions,
      requireInteraction: Boolean(notice.approvalId),
    }),
  );
});

// The browser replaced this subscription (it expired or was rotated): give the hub the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const auth = await readAuth();
      if (!auth || !auth.token) return;
      const old = event.oldSubscription;
      const sub = event.newSubscription || (old && old.options ? await self.registration.pushManager.subscribe(old.options) : null);
      const base = auth.baseUrl || '';
      const post = (path, body) =>
        fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify(body) });
      if (old && old.endpoint) await post('/api/notify/unsubscribe', { endpoint: old.endpoint }).catch(() => undefined);
      if (!sub) return;
      const json = sub.toJSON();
      await post('/api/notify/subscribe', { endpoint: json.endpoint, keys: json.keys }).catch(() => undefined);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  const notice = event.notification.data || {};
  event.notification.close();
  if ((event.action === 'allow' || event.action === 'deny') && notice.approvalId) {
    event.waitUntil(answerApproval(notice, event.action));
    return;
  }
  const target = notice.link || (notice.sessionId ? `/s/${notice.sessionId}` : '/');
  event.waitUntil(focusOrOpen(target));
});

async function focusOrOpen(target) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of list) {
    if (new URL(client.url).origin === self.location.origin) {
      client.postMessage({ type: 'navigate', to: target });
      return client.focus();
    }
  }
  return self.clients.openWindow(target);
}

/** The app stores { baseUrl, token } in IndexedDB so actions work with no window open. */
function readAuth() {
  return new Promise((resolve) => {
    const open = indexedDB.open('conclave', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get('auth');
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
  });
}

/**
 * Send an Allow or Deny tap to the hub. The signed link needs no token; try it
 * on the hub this app talks to, then this origin, then the address in the
 * link (the hub's public address may have changed since, with a new tunnel).
 * Without a signed link, use the token the app saved.
 */
async function sendDecision(notice, action, auth) {
  const signed = action === 'allow' ? notice.approveUrl : notice.denyUrl;
  if (signed) {
    const link = new URL(signed, self.location.origin);
    const bases = [...new Set([auth && auth.baseUrl, self.location.origin, link.origin].filter(Boolean))];
    let last = null;
    for (const base of bases) {
      try {
        const res = await fetch(new URL(link.pathname + link.search, base), { method: 'POST', headers: { accept: 'application/json' } });
        if (res.ok || (res.status !== 404 && res.status < 500)) return res;
        last = res;
      } catch {
        /* this address does not answer; try the next */
      }
    }
    if (last) return last;
  }
  if (!auth || !auth.token) return null;
  const body = action === 'allow' ? { decision: 'allow', scope: 'once' } : { decision: 'deny' };
  return fetch(`${auth.baseUrl || ''}/api/approvals/${encodeURIComponent(notice.approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
  });
}

async function answerApproval(notice, action) {
  const id = notice.approvalId;
  const quiet = (title, body) =>
    self.registration.showNotification(title, { body, tag: `done-${id}`, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', silent: true });
  try {
    const res = await sendDecision(notice, action, await readAuth());
    if (!res) return focusOrOpen(notice.sessionId ? `/s/${notice.sessionId}` : '/approvals');
    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      if (/not pending/.test(text)) return quiet('Already answered', 'This approval was answered somewhere else.');
    }
    if (!res.ok) throw new Error(String(res.status));
    await quiet(action === 'allow' ? 'Allowed' : 'Denied', 'Approval sent to the hub.');
  } catch {
    await focusOrOpen(notice.sessionId ? `/s/${notice.sessionId}` : '/approvals');
  }
}
