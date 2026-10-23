/**
 * Screenshots of the web app the demo hub serves (scripts/demo-hub.ts), at
 * 1440x900 and 390x844 (phone, 2x), dark and light.
 *
 *   bun scripts/demo-hub.ts --info /tmp/demo.json &
 *   node scripts/screenshots/web.mjs /tmp/demo.json docs/screenshots/apps/web
 *
 * Phone shots go the way a person would on the iPhone app (docs/design/
 * MOBILE-V2.md): the menu button opens the side panel, and its rows open
 * Chats, Code, the Inbox, a conversation from Recents, the pages under More
 * and Settings. SIZES=mobile (or desktop) and THEMES=dark limit a run;
 * ONLY=friends,friend,inbox shoots only those names (map takes both Map
 * shots); VIEWPORT=360x780
 * shoots the phone at another size.
 *
 * Friends (Settings, Friends, the invite, a friend's notes and details) use
 * the friends the demo hub seeds; an invite borrows an own URL for its shot.
 * Shares (send-*, share-*, shares) use the shares it seeds: Send to friend
 * from a session's menu (the conversation sheet on a phone), the review with
 * a value shown and kept, the sent state, an offer, Ben's share accepted
 * with its diff, Apply code's plan, Continue as fork, an unsent and an
 * expired share. The shots leave the hub as they found it: a friend's read
 * mark does not move, and Send answers here without sending.
 *
 * Repo sessions (docs/DESIGN.md 30): Settings, GitHub, Code from GitHub on
 * Home, and the demo hub's repo session with its pull request open, on a
 * desktop and in the phone's conversation sheet (repo-* and settings-github).
 *
 * The "/" menu, its Connectors and Context sheets and Group by Project
 * (slash-menu, connectors, context, project, and recents-project on the
 * phone) use the conclave sessions the demo hub seeds on three devices. A
 * screen's `prefs` go into the app's saved list options before it loads.
 *
 * Needs Playwright (npm i -g playwright, or one the global npm root has) and
 * a Chromium: CHROMIUM_PATH, else Playwright's own. The web app must be
 * built (bun run --filter @conclave/web build) for the hub to serve it.
 *
 * The Map's shots (map, map-drawer) take the web mock's map data
 * (packages/web/src/mock/map-data.ts, printed by Bun): three projects,
 * about fifteen agents and a workflow, more than the demo hub has. They run
 * with motion on, so the streams show.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(join(root, 'playwright'));
  }
}

const [infoFile, outDir = 'docs/screenshots/apps/web'] = process.argv.slice(2);
if (!infoFile) {
  console.error('usage: node scripts/screenshots/web.mjs <demo info.json> [out dir]');
  process.exit(2);
}
const info = JSON.parse(readFileSync(infoFile, 'utf8'));
mkdirSync(outDir, { recursive: true });

const { chromium } = loadPlaywright();
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const [vw, vh] = (process.env.VIEWPORT || '390x844').split('x').map(Number);
const sizes = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
].filter((s) => !process.env.SIZES || process.env.SIZES.split(',').includes(s.name));
const themes = (process.env.THEMES || 'dark,light').split(',');
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;
const wanted = (s) => !only || only.has(s.name);

const s = info.sessions;

/** Desktop: name, path, and what to do before the shot. */
const desktop = [
  { name: 'home', path: '/' },
  { name: 'chats', path: '/sessions' },
  { name: 'session-diff', path: `/s/${s.fix}` },
  { name: 'approval', path: `/s/${s.push}` },
  { name: 'inbox', path: '/inbox' },
  { name: 'question', path: `/s/${s.routes}` },
  { name: 'chat', path: `/chat/${s.chat}` },
  ...(info.workflowRun ? [{ name: 'workflow', path: `/workflows/runs/${info.workflowRun}` }] : []),
  { name: 'settings-remote', path: '/settings/remote' },
  { name: 'settings-identity', path: '/settings/remote', scrollTo: '#identity' },
  { name: 'devices', path: '/devices' },
  { name: 'devices-pair', path: '/devices', click: /^Pair a device$/, wait: 'svg' },
  ...(s.repo
    ? [
        { name: 'settings-github', path: '/settings/github' },
        { name: 'repo-start', path: '/', steps: (p) => fromGithub(p, false) },
        { name: 'repo-session', path: `/s/${s.repo}` },
      ]
    : []),
  ...(s.conclaveMac
    ? [
        // conclave on three devices (scripts/demo-hub.ts seedConclave): the "/" menu, two of its sheets, Group by Project
        { name: 'slash-menu', path: `/s/${s.conclaveMac}`, steps: (p) => openSlash(p, '') },
        { name: 'connectors', path: `/s/${s.conclaveMac}`, steps: (p) => runSlash(p, 'mcp', false) },
        { name: 'context', path: `/s/${s.conclaveMac}`, steps: (p) => runSlash(p, 'context', false) },
        { name: 'project', path: `/s/${s.conclaveMac}`, prefs: { listGroup: 'project' } },
      ]
    : []),
  ...(info.friends
    ? [
        // the demo hub's friends (scripts/demo-hub.ts seedFriends): remote access off, a new key, requests, friends
        { name: 'friends', path: '/settings/friends' },
        { name: 'friends-invite', path: '/settings/friends', steps: (p) => makeInvite(p) },
        { name: 'friend', path: `/settings/friends/${info.friends.alice}` },
      ]
    : []),
  ...(info.shares
    ? [
        // shares (scripts/demo-hub.ts seedShares)
        { name: 'send-review', path: `/s/${s.fix}`, steps: (p) => sendFlow(p, false, 'review') },
        { name: 'send-sent', path: `/s/${s.fix}`, steps: (p) => sendFlow(p, false, 'sent') },
        { name: 'shares', path: '/shares' },
        { name: 'share-offer', path: `/shares/${info.shares.offer}` },
        { name: 'share-view', path: `/shares/${info.shares.accepted}` },
        { name: 'share-diff', path: `/shares/${info.shares.accepted}`, steps: (p) => scrollPageTo(p, '[aria-labelledby="code-h"]') },
        { name: 'share-fork', path: `/shares/${info.shares.accepted}`, steps: (p) => openForm(p, 'Continue as fork') },
        { name: 'share-apply', path: `/shares/${info.shares.accepted}`, steps: (p) => applyPlan(p) },
        { name: 'share-revoked', path: `/shares/${info.shares.revoked}` },
        { name: 'share-expired', path: `/shares/${info.shares.expired}` },
      ]
    : []),
];

/**
 * Send to friend: from the session's menu (desktop) or its sheet (phone),
 * Alice picked, the review read, the path it found shown and kept anyway;
 * `sent` sends too (answered here, see shareRoutes).
 */
async function sendFlow(page, mobile, until) {
  if (mobile) {
    await page.getByRole('button', { name: /, details$/ }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Send to friend' }).click();
  } else {
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: /^Send to friend/ }).click();
  }
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  if (until === 'pick') return;
  await page.getByRole('checkbox', { name: 'Alice' }).check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('list', { name: 'Values taken out' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Show the / }).first().click();
  await page.getByRole('button', { name: 'Keep anyway' }).first().click();
  await page.waitForTimeout(900);
  await page.getByRole('heading', { name: /^Taken out/ }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  if (until === 'review') return;
  await page.getByRole('button', { name: /^Send to Alice/ }).click();
  await page.getByRole('status').filter({ hasText: 'Sent' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** A dialog from a share's page, opened and left open. */
async function openForm(page, button) {
  await page.getByRole('button', { name: button }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(500);
}

/** Apply code: MacBook and the demo repo, then the hub's checked plan, waiting for approval. */
async function applyPlan(page) {
  await openForm(page, 'Apply code');
  await page.getByLabel('Folder in the repository').fill(`${info.home}/code/fernway-web`);
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('heading', { name: 'Approve the code' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
}

/**
 * What a context answers itself so the shots leave the hub as they found
 * it: a friend's read mark stays where the seed put it (the next theme
 * counts the same), and Send answers as the hub would without sending.
 */
async function shareRoutes(ctx) {
  await ctx.route(/\/api\/friends\/[^/]+\/read$/, (route) => route.fulfill({ status: 409, json: { error: 'The screenshots leave read marks alone.' } }));
  await ctx.route(/\/api\/shares$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    const res = await fetch(`${info.url}/api/shares/preview`, { method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, to: undefined, title: undefined, note: undefined }) });
    const p = await res.json();
    const now = Date.now();
    await route.fulfill({
      json: {
        id: '01SHOTS0000000000000000000',
        sessionId: body.sessionId,
        kind: p.kind,
        title: body.title || p.title,
        ...(body.note ? { note: body.note } : {}),
        revision: 1,
        state: 'active',
        options: p.options,
        summary: { messages: p.messages, sessions: p.sessions, ...(p.code && p.code.files ? { code: { kind: p.code.kind, files: p.code.files.length } } : {}), bytes: p.bytes },
        createdAt: now,
        updatedAt: now,
        recipients: (body.to ?? []).map((friendId) => ({ friendId, friendName: 'Alice', state: 'sent', revision: 1 })),
      },
    });
  });
}

/**
 * Scroll the page a section is in so the section sits at the top, as far as
 * the page goes. scrollIntoView would also move the shell under the bar
 * when the page ends first.
 */
async function scrollPageTo(page, selector) {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      let box = el.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    });
  await page.waitForTimeout(300);
}

/** The hub's remote access, through its API with the owner token. */
async function setRemote(body) {
  const res = await fetch(`${info.url}/api/remote`, { method: 'PUT', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PUT /api/remote answered ${res.status}`);
}

/**
 * An invite needs an address a friend can reach, which the demo hub has
 * none of: it borrows an own URL for the shot, makes the invite, and
 * shows Add a friend. afterShot puts remote access back.
 */
async function makeInvite(page) {
  await setRemote({ mode: 'custom', url: 'https://conclave.sam-rivera.net' });
  await page.reload();
  await settle(page);
  await page.getByRole('button', { name: /^Make an invite$/ }).first().click();
  await page.locator('[data-invite-link]').first().waitFor({ timeout: 10_000 });
  await scrollPageTo(page, '#add');
  await page.waitForTimeout(300);
}

async function afterShot(name) {
  if (name === 'friends-invite') await setRemote({ mode: 'off', url: null });
}

/**
 * Code from GitHub on Home: Session (Code on a phone), then the repository
 * list. A desktop opens From GitHub in the box; a phone opens the options
 * sheet and its GitHub repository field.
 */
async function fromGithub(page, mobile) {
  if (mobile) {
    await page.getByRole('radio', { name: 'Code' }).click();
    await page.getByRole('button', { name: /^Options:/ }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'From GitHub' }).click();
  } else {
    const sw = page.getByRole('button', { name: /What to start/ });
    if ((await sw.textContent())?.trim() !== 'Session') {
      await sw.click();
      await page.getByRole('menuitemcheckbox', { name: /Session/ }).first().click();
    }
    await page.getByRole('button', { name: 'From GitHub' }).click();
  }
  await page.getByRole('listbox', { name: 'Repositories' }).getByRole('option').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

/** The side panel, from the menu button in the top bar. */
async function openPanel(page) {
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await page.locator('[data-panel]').waitFor();
  await page.waitForTimeout(400);
}

/** A row of the side panel: Chats, Code, Inbox, a recent chat or session, a page under More. Its name may go on with a count or a state. */
async function viaPanel(page, name) {
  await openPanel(page);
  const starts = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  await page.locator('[data-panel]').getByRole('link', { name: starts }).first().click();
  await page.waitForTimeout(500);
}

/** Type "/" and what follows into the session's composer; the menu opens. */
async function openSlash(page, query) {
  const box = page.locator('textarea[data-composer]').last();
  await box.focus();
  await page.keyboard.type(`/${query}`, { delay: 30 });
  await page.locator('[role=listbox][aria-label=Commands]').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
}

/** Run a "/" command that opens a sheet over the session: Enter on a desktop, a tap on a phone. */
async function runSlash(page, name, mobile) {
  await openSlash(page, name);
  if (mobile) await page.locator('[role=listbox][aria-label=Commands] [role=option]').first().click();
  else await page.keyboard.press('Enter');
  await page.locator('[data-session-sheet]').waitFor({ timeout: 5_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/** The app's saved list options (store/ui.ts), set before a screen loads and cleared after. */
async function setPrefs(page, prefs) {
  await page.evaluate((p) => {
    const key = 'conclave.ui';
    const cur = JSON.parse(localStorage.getItem(key) || '{}');
    const next = { ...cur };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    localStorage.setItem(key, JSON.stringify(next));
  }, prefs);
}

/** Phones: each shot starts on Home and goes where a person would tap. */
const phone = [
  { name: 'home' },
  // nothing waits on you: the greeting alone over the composer
  { name: 'home-empty', empty: true },
  { name: 'panel', steps: openPanel },
  { name: 'chats', steps: (p) => viaPanel(p, 'Chats') },
  { name: 'code', steps: (p) => viaPanel(p, 'Code') },
  { name: 'inbox', steps: (p) => viaPanel(p, 'Inbox') },
  { name: 'chat', steps: (p) => viaPanel(p, 'Plan the week') },
  { name: 'session', steps: (p) => viaPanel(p, 'Fix login redirect') },
  {
    name: 'session-tools',
    steps: async (p) => {
      await viaPanel(p, 'Fix login redirect');
      await p.getByRole('button', { name: /^Read redirect\.ts/ }).first().click();
      await p.waitForTimeout(300);
    },
  },
  { name: 'approval', steps: (p) => viaPanel(p, 'Push the login fix') },
  { name: 'question', steps: (p) => viaPanel(p, 'Move session routes to v2') },
  ...(s.conclaveMac
    ? [
        {
          name: 'slash-menu',
          steps: async (p) => {
            await viaPanel(p, 'Group the session list by project');
            await openSlash(p, '');
          },
        },
        {
          name: 'connectors',
          steps: async (p) => {
            await viaPanel(p, 'Group the session list by project');
            await runSlash(p, 'mcp', true);
          },
        },
        {
          name: 'context',
          steps: async (p) => {
            await viaPanel(p, 'Group the session list by project');
            await runSlash(p, 'context', true);
          },
        },
        { name: 'project', prefs: { listGroup: 'project' }, steps: (p) => viaPanel(p, 'Code') },
        { name: 'recents-project', prefs: { recentsGroup: 'project' }, steps: openPanel },
      ]
    : []),
  {
    name: 'conversation-sheet',
    steps: async (p) => {
      await viaPanel(p, 'Fix login redirect');
      await p.getByRole('button', { name: 'Fix login redirect, details' }).click();
      await p.waitForTimeout(400);
    },
  },
  {
    name: 'settings',
    steps: async (p) => {
      await openPanel(p);
      await p.locator('[data-panel]').getByRole('link', { name: 'Settings' }).click();
      await p.waitForTimeout(500);
    },
  },
  { name: 'settings-remote', steps: (p) => viaPanel(p, 'Remote access') },
  {
    name: 'settings-identity',
    steps: async (p) => {
      await viaPanel(p, 'Remote access');
      await p.locator('#identity').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await p.waitForTimeout(300);
    },
  },
  ...(info.workflowRun
    ? [
        {
          name: 'workflow',
          steps: async (p) => {
            await viaPanel(p, 'Workflows');
            await p.getByRole('link', { name: 'Runs' }).click();
            await p.getByText('review-login-fix').first().click();
            await p.waitForTimeout(500);
          },
        },
      ]
    : []),
  ...(s.repo
    ? [
        { name: 'repo-start', steps: (p) => fromGithub(p, true) },
        { name: 'repo-session', steps: (p) => viaPanel(p, 'Raise the session timeout') },
        {
          name: 'repo-sheet',
          steps: async (p) => {
            await viaPanel(p, 'Raise the session timeout');
            await p.getByRole('button', { name: 'Raise the session timeout, details' }).click();
            await p.waitForTimeout(400);
          },
        },
        {
          name: 'settings-github',
          steps: async (p) => {
            await openPanel(p);
            await p.locator('[data-panel]').getByRole('link', { name: 'Settings' }).click();
            await p.waitForTimeout(400);
            await p.getByRole('link', { name: /^GitHub/ }).click();
            await p.waitForTimeout(500);
          },
        },
      ]
    : []),
  { name: 'devices', steps: (p) => viaPanel(p, 'Devices') },
  {
    name: 'devices-pair',
    steps: async (p) => {
      await viaPanel(p, 'Devices');
      await p.getByRole('button', { name: /^Pair a device$/ }).first().click();
      await p.locator('svg').last().waitFor({ timeout: 5_000 }).catch(() => {});
    },
  },
  ...(info.friends
    ? [
        // Friends from the side panel's More rows; opening a friend's notes takes them off the Inbox count, so these come after the Inbox
        { name: 'friends', steps: (p) => viaPanel(p, 'Friends') },
        {
          name: 'friends-list',
          steps: async (p) => {
            await viaPanel(p, 'Friends');
            await scrollPageTo(p, '#friends');
            await p.waitForTimeout(300);
          },
        },
        {
          name: 'friends-invite',
          steps: async (p) => {
            await viaPanel(p, 'Friends');
            await makeInvite(p);
          },
        },
        { name: 'friend', steps: (p) => openFriend(p, 'Alice') },
        {
          name: 'friend-details',
          steps: async (p) => {
            await openFriend(p, 'Alice');
            await p.getByRole('button', { name: 'Alice, details' }).click();
            await p.waitForTimeout(400);
          },
        },
      ]
    : []),
  ...(info.shares
    ? [
        // Send to friend from the conversation's sheet, then the shares from Friends, Shares
        { name: 'send-pick', steps: async (p) => (await viaPanel(p, 'Fix login redirect'), sendFlow(p, true, 'pick')) },
        { name: 'send-review', steps: async (p) => (await viaPanel(p, 'Fix login redirect'), sendFlow(p, true, 'review')) },
        { name: 'send-sent', steps: async (p) => (await viaPanel(p, 'Fix login redirect'), sendFlow(p, true, 'sent')) },
        { name: 'shares', steps: (p) => openShares(p) },
        { name: 'share-offer', steps: (p) => openShares(p, 'Fix flaky auth test') },
        { name: 'share-view', steps: (p) => openShares(p, 'Cache the session lookup') },
        {
          name: 'share-diff',
          steps: async (p) => {
            await openShares(p, 'Cache the session lookup');
            await scrollPageTo(p, '[aria-labelledby="code-h"]');
          },
        },
        { name: 'share-fork', steps: async (p) => (await openShares(p, 'Cache the session lookup'), openForm(p, 'Continue as fork')) },
        { name: 'share-apply', steps: async (p) => (await openShares(p, 'Cache the session lookup'), applyPlan(p)) },
        { name: 'share-revoked', steps: (p) => openShares(p, 'Pick a router for the new flat') },
      ]
    : []),
];

/** Friends from the side panel, then Shares, then a share by its title. */
async function openShares(page, title) {
  await viaPanel(page, 'Friends');
  await scrollPageTo(page, '#shares');
  await page.locator('#shares a[href="/shares"]').first().click();
  await page.waitForTimeout(500);
  if (!title) return;
  await page.getByRole('link', { name: new RegExp(`^${title}`) }).first().click();
  await page.waitForTimeout(800);
}

/** Friends from the side panel, then a friend's row. */
async function openFriend(page, name) {
  await viaPanel(page, 'Friends');
  await scrollPageTo(page, '#friends');
  await page.getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().click();
  await page.waitForTimeout(500);
}

/** The address and password form: on a phone behind "Use address and password", on a desktop a segment. */
async function passwordForm(page, mobile) {
  if (mobile) await page.getByRole('button', { name: 'Use address and password' }).click();
  else await page.getByRole('radio', { name: 'Password' }).click();
  if (info.password) await page.locator('input[type="password"]').first().fill(info.password);
}

/** Connect, in a browser that has never seen the hub: the first screen, the password form, and the fingerprint a password login shows. */
const connects = [
  { name: 'connect' },
  { name: 'connect-password', steps: passwordForm },
  {
    name: 'connect-fingerprint',
    steps: async (page, mobile) => {
      await passwordForm(page, mobile);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 10_000 });
    },
  },
];

/** The mock map, as of now, under the demo hub's name. */
async function mapFixture() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'web', 'src', 'mock', 'map-data.ts');
  const json = execFileSync('bun', ['-e', `const m = await import(${JSON.stringify(file)}); process.stdout.write(JSON.stringify(m.mapFixture(Date.now())))`], { encoding: 'utf8' });
  const snap = JSON.parse(json);
  const hub = await fetch(`${info.url}/api/info`, { headers: { authorization: `Bearer ${info.token}` } }).then((r) => r.json());
  snap.hub.name = hub.name;
  for (const d of snap.devices) if (d.id === 'local') d.name = hub.name;
  return snap;
}

/** The Map on its own page, and with a node's details open. */
async function mapShots(browser, opts, mobile, shoot) {
  const snap = await mapFixture();
  const ctx = await browser.newContext({ ...opts, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await page.route(/\/api\/map(\?.*)?$/, (route) => route.fulfill({ json: snap }));
  // the demo hub's own map deltas would add its sessions to the mock map: leave them out
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (!String(m).includes('"map.delta"')) ws.send(m);
    });
    ws.onMessage((m) => server.send(m));
  });
  try {
    await page.goto(`${info.url}/#token=${encodeURIComponent(info.token)}`);
    await settle(page);
    if (mobile) await viaPanel(page, 'Map');
    else await page.goto(`${info.url}/map`);
    await settle(page);
    // the streams fill the links in about three seconds
    await page.waitForTimeout(3500);
    await shoot(page, 'map');
    await page.getByRole('button', { name: mobile ? /^Fix login redirect/ : /^Move auth middleware to jose/ }).click();
    await page.waitForTimeout(mobile ? 900 : 700);
    await shoot(page, 'map-drawer');
  } catch (err) {
    console.error(`map ${mobile ? 'mobile' : 'desktop'}: ${err.message}`);
  }
  await ctx.close();
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

const browser = await chromium.launch({ executablePath });
let shots = 0;
try {
  for (const size of sizes) {
    for (const theme of themes) {
      const { name: sizeName, ...device } = size;
      const mobile = sizeName === 'mobile';
      const opts = { ...device, colorScheme: theme, reducedMotion: 'reduce' };
      const shoot = async (page, name) => {
        const file = join(outDir, `${name}-${sizeName}-${theme}.png`);
        await page.screenshot({ path: file });
        shots++;
        console.log(file);
      };

      for (const connect of connects.filter(wanted)) {
        const ctx = await browser.newContext(opts);
        const page = await ctx.newPage();
        await page.goto(`${info.url}/`);
        await settle(page);
        try {
          if (connect.steps) await connect.steps(page, mobile);
          await settle(page);
          await shoot(page, connect.name);
        } catch (err) {
          console.error(`${connect.name} ${sizeName} ${theme}: ${err.message}`);
        }
        await ctx.close();
      }

      const ctx = await browser.newContext(opts);
      await shareRoutes(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => console.error(`page error: ${err.message}`));
      // the app reads #token= once, saves it, and drops it from the address
      await page.goto(`${info.url}/#token=${encodeURIComponent(info.token)}`);
      await settle(page);

      if (!mobile) {
        for (const screen of desktop.filter(wanted)) {
          try {
            if (screen.prefs) await setPrefs(page, screen.prefs);
            await page.goto(`${info.url}${screen.path}`);
            await settle(page);
            if (screen.scrollTo) {
              await page.locator(screen.scrollTo).first().evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
              await page.waitForTimeout(300);
            }
            if (screen.click) {
              await page.getByRole('button', { name: screen.click }).first().click();
              if (screen.wait) await page.locator(screen.wait).last().waitFor({ timeout: 5_000 }).catch(() => {});
              await settle(page);
            }
            if (screen.steps) {
              await screen.steps(page);
              await settle(page);
            }
            await shoot(page, screen.name);
          } catch (err) {
            console.error(`${screen.name} ${sizeName} ${theme}: ${err.message}`);
          } finally {
            await afterShot(screen.name);
            if (screen.prefs) await setPrefs(page, Object.fromEntries(Object.keys(screen.prefs).map((k) => [k, null]))).catch(() => {});
          }
        }
        await ctx.close();
        if (!only || only.has('map')) await mapShots(browser, opts, false, shoot);
        continue;
      }

      for (const screen of phone.filter(wanted)) {
        // Home with nothing waiting: the hub's approvals and questions answer empty in a context of its own
        const own = screen.empty ? await browser.newContext(opts) : undefined;
        if (own) await shareRoutes(own);
        const p = own ? await own.newPage() : page;
        try {
          if (own) {
            await p.route(/\/api\/(approvals|questions)$/, (route) => route.fulfill({ json: [] }));
            await p.goto(`${info.url}/#token=${encodeURIComponent(info.token)}`);
          } else {
            if (screen.prefs) await setPrefs(p, screen.prefs);
            await p.goto(`${info.url}/`);
          }
          await settle(p);
          if (screen.steps) await screen.steps(p);
          await settle(p);
          await shoot(p, screen.name);
        } catch (err) {
          console.error(`${screen.name} ${sizeName} ${theme}: ${err.message}`);
        } finally {
          await afterShot(screen.name);
          if (screen.prefs && !own) await setPrefs(p, Object.fromEntries(Object.keys(screen.prefs).map((k) => [k, null]))).catch(() => {});
        }
        await own?.close();
      }
      await ctx.close();
      if (!only || only.has('map')) await mapShots(browser, opts, true, shoot);
    }
  }
} finally {
  await browser.close();
}
console.log(`${shots} screenshots in ${outDir}`);
