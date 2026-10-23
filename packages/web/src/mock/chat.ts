/**
 * Mock routes for chat mode (docs/design/CHAT-AND-MOTION.md, section 3).
 *
 * Chats are sessions with kind "chat": the chat agent, the hub as device, and
 * three switches (web search, memory, thinking). The busy hub has eight chats
 * over the last two weeks. A new message in a chat streams a reply that
 * honors the switches: thinking only when it is on, a WebSearch with
 * citations only when web search is on, memory only when memory is on, and a
 * code block. Ask it to "remember" something and it saves to memory; ask for
 * an svg or a page and the reply carries a fenced svg or html block.
 *
 * Ask it to run something on a machine and it points at Continue as a
 * session; put "fail" in a message and the reply fails the way a refused
 * key does (an error notice and the error state, as the hub does). Put
 * "ask first" in a message and the web search waits on an approval, the way
 * a PreToolUse hook that asks holds it (the chat waits on you; answer in the
 * Inbox). Messages
 * sent while a reply runs wait on the hub, listed by session.queue (shared
 * with the session routes, mock/queue.ts), and go out after it, each with
 * the pendingIds of the bubble it replaces; Stop holds them. Rewind keeps
 * messages up to the seq it is given, as the hub does.
 *
 * Other sessions fall through to the routes in index.ts (ctx.pass).
 */
import type { ChatSettings, ContentBlock, EngineEvent, MemoryEntry, Message, Session } from '@conclave/core/types';
import type { MockCtx } from './index';
import { isEffortSetting } from '@conclave/core/providers/effort';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SONNET = 'anthropic/claude-sonnet-5-5';
const OPUS = 'anthropic/claude-opus-5-5';
const GPT = 'openai/gpt-5.5';
const GLM = 'zai/glm-5';

const DEFAULTS: ChatSettings = { webSearch: true, memory: true };

type Seed = Omit<Session, 'stats' | 'mode' | 'permissionMode' | 'cwd' | 'device' | 'status' | 'tags' | 'pinned' | 'archived' | 'agent' | 'kind'> & { agent?: string };

function chatSession(s: Seed, messages: number): Session {
  return {
    agent: 'chat',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    stats: { messages, inputTokens: 3_200 * messages, outputTokens: 420 * messages, cacheReadTokens: 2_100 * messages, costUsd: 0.006 * messages },
    ...s,
    kind: 'chat',
  };
}

// ---------------------------------------------------------------------------
// Seeded chats
// ---------------------------------------------------------------------------

interface Turn {
  role: 'user' | 'assistant';
  at: number;
  content: ContentBlock[];
  model?: string;
  kind?: Message['kind'];
  author?: string;
  meta?: Record<string, unknown>;
}

const t = (text: string): ContentBlock => ({ type: 'text', text });
/** The hub's block for recalled notes on a user message (core session/transcript.ts reminder()). */
const recallReminder = (ids: string[]): ContentBlock => ({
  type: 'text',
  text: `<system-reminder>\nRelevant memories (from earlier sessions; may be outdated):\n${ids.map((id) => `- [${id}] ${MEMORY_LINES[id] ?? 'A note from memory.'}`).join('\n')}\n</system-reminder>`,
});
const MEMORY_LINES: Record<string, string> = {
  mm2: 'Desktop runs Arch Linux with Hyprland and zsh. Homelab is Proxmox VE 9 with PBS.',
  mm5: 'Caddy runs in LXC 101 at 10.0.20.11. Proxmox UI is never proxied.',
  mm11: 'OS course uses the xv6-riscv codebase; assignments are graded on a RISC-V QEMU.',
};
const think = (thinking: string, durationMs: number): ContentBlock => ({ type: 'thinking', thinking, durationMs });

const CADDY_RESULTS = [
  { title: 'Automatic HTTPS, Caddy documentation', url: 'https://caddyserver.com/docs/automatic-https', date: '2026-08-12' },
  { title: 'Caddy certificates on Tailscale', url: 'https://tailscale.com/kb/1190/caddy-certificates', date: '2026-06-03' },
  { title: 'Enabling HTTPS, Tailscale docs', url: 'https://tailscale.com/kb/1153/enabling-https' },
];

function searchResult(id: string, query: string, results: typeof CADDY_RESULTS, ms = 1_240): ContentBlock {
  const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n\n');
  return { type: 'tool_result', toolUseId: id, content: `Web search results for "${query}" (via brave)\n${body}`, meta: { provider: 'brave', count: results.length, results, durationMs: ms } };
}

function seeds(now: number): Array<{ session: Session; turns: Turn[] }> {
  const at = (ms: number) => now - ms;
  return [
    // handed two jobs on with Delegate (docs/DESIGN.md 43): their sessions are s_dlg_names and s_dlg_mail in mock/data.ts
    {
      session: chatSession({ id: 'c_capstone', title: 'Capstone', model: SONNET, createdAt: at(26 * MIN), updatedAt: at(5 * MIN), chat: DEFAULTS }, 8),
      turns: [
        { role: 'user', at: at(26 * MIN), content: [t('look for names in the pdfs in my capstone folder, ask code on the arch box')] },
        {
          role: 'assistant',
          at: at(26 * MIN - 2_000),
          model: SONNET,
          content: [{ type: 'tool_use', id: 'tu_dlg_names', name: 'Delegate', input: { to: 'code', device: 'arch-desktop', folder: '~/uni/capstone', description: 'Find names in the capstone PDFs', prompt: 'List every person named in the PDFs in ~/uni/capstone, with the file each is in.', readOnly: true } }],
        },
        {
          role: 'user',
          at: at(22 * MIN),
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tu_dlg_names',
              content: 'Code (explore) on arch-desktop in /home/kai/uni/capstone answered:\n\nThree people are named:\n- Ada Lovelace, proposal.pdf\n- Grace Hopper, interim-report.pdf\n- Dr. Moore, feedback.pdf',
              meta: { sessionId: 's_dlg_names', agent: 'explore', delegate: { to: 'code', device: 'arch-desktop', deviceName: 'arch-desktop', folder: '/home/kai/uni/capstone', readOnly: true, permissionMode: 'plan' }, durationMs: 241_000 },
            },
          ],
        },
        { role: 'assistant', at: at(22 * MIN - 1_500), model: SONNET, content: [t('Code read the three PDFs in ~/uni/capstone on arch-desktop. They name **Ada Lovelace** (proposal.pdf), **Grace Hopper** (interim-report.pdf) and **Dr. Moore** (feedback.pdf).')] },
        { role: 'user', at: at(6 * MIN), content: [t('ask the assistant to draft a reply to Dr. Moore thanking him for the feedback')] },
        {
          role: 'assistant',
          at: at(6 * MIN - 2_000),
          model: SONNET,
          content: [{ type: 'tool_use', id: 'tu_dlg_mail', name: 'Delegate', input: { to: 'assistant', description: 'Draft the reply to Dr. Moore', prompt: 'Draft a short reply to Dr. Moore thanking him for the feedback on the capstone interim report. Leave it as a draft.', readOnly: false, background: true } }],
        },
        {
          role: 'user',
          at: at(6 * MIN - 3_000),
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tu_dlg_mail',
              content: 'Assistant (assistant) on madx in /root started in the background (session s_dlg_mail). Its answer arrives in a <subagent_result> block when it finishes; there is no need to wait.',
              meta: { sessionId: 's_dlg_mail', agent: 'assistant', delegate: { to: 'assistant', device: 'local', deviceName: 'madx', folder: '/root', readOnly: false, permissionMode: 'default' }, background: true },
            },
          ],
        },
        { role: 'assistant', at: at(5 * MIN), model: SONNET, content: [t('The assistant is drafting it now. I will tell you when the draft is ready.')] },
      ],
    },
    {
      session: chatSession({ id: 'c_caddy', title: 'Caddy certs for tailnet names', model: SONNET, createdAt: at(41 * MIN), updatedAt: at(38 * MIN), chat: { ...DEFAULTS, thinking: 'low' } }, 4),
      turns: [
        { role: 'user', at: at(41 * MIN), content: [t('can caddy get certs for my tailnet names on its own? want https on madx without opening ports'), recallReminder(['mm5'])], meta: { recalled: ['mm5'] } },
        {
          role: 'assistant',
          at: at(41 * MIN - 2_000),
          model: SONNET,
          content: [
            think('Memory says Caddy runs in LXC 101 at 10.0.20.11. The question is whether Caddy can fetch a tailnet certificate itself. Check the current docs for the ts.net integration and the permission tailscaled needs.', 3_400),
            { type: 'tool_use', id: 'tu_c1', name: 'WebSearch', input: { query: 'caddy tailscale https certificate ts.net' } },
          ],
        },
        { role: 'user', at: at(41 * MIN - 3_400), content: [searchResult('tu_c1', 'caddy tailscale https certificate ts.net', CADDY_RESULTS)] },
        {
          role: 'assistant',
          at: at(41 * MIN - 4_000),
          model: SONNET,
          content: [
            t(
              "Yes. When a site address ends in `.ts.net`, Caddy asks tailscaled for the certificate, so you need no DNS challenge and no open ports ([Caddy docs](https://caddyserver.com/docs/automatic-https)).\n\nOn CT 101, let the caddy user use the tailscaled socket:\n\n```sh\necho 'TS_PERMIT_CERT_UID=caddy' >> /etc/default/tailscaled\nsystemctl restart tailscaled\n```\n\nThen use the full name in the Caddyfile:\n\n```caddyfile\nmadx.tail4e2a.ts.net {\n\treverse_proxy 10.0.20.14:7420\n}\n```\n\nHTTPS certificates must be turned on for the tailnet first, on the DNS page of the admin console ([Tailscale](https://tailscale.com/kb/1153/enabling-https)).",
            ),
          ],
        },
      ],
    },
    {
      session: chatSession({ id: 'c_sock', title: 'Socket server timeouts for COMP3310', model: OPUS, createdAt: at(3 * HOUR), updatedAt: at(2.6 * HOUR), chat: { ...DEFAULTS, thinking: 'medium' } }, 5),
      turns: [
        { role: 'user', at: at(3 * HOUR), content: [t('my comp3310 socket server hangs forever when a client connects and sends nothing. how do I time that out in python?'), recallReminder(['mm11'])], meta: { recalled: ['mm11'] } },
        {
          role: 'assistant',
          at: at(3 * HOUR - 1_000),
          model: OPUS,
          content: [
            think('A blocking recv on the accepted socket waits forever. settimeout on the connection socket, not the listening one, and catch socket.timeout (TimeoutError since 3.10). Keep it to the one method; the assignment uses plain sockets, not asyncio.', 6_100),
            t(
              'Set a timeout on the accepted connection, not the listening socket, and close it when the timeout fires:\n\n```python\nconn, addr = server.accept()\nconn.settimeout(10)\ntry:\n    data = conn.recv(4096)\nexcept TimeoutError:\n    conn.close()\n    continue\n```\n\n`TimeoutError` is what `socket.timeout` became in Python 3.10, so this catches both. Ten seconds is a guess; the spec for assignment 2 may name a value, so check it before you hand in.',
            ),
          ],
        },
        { role: 'user', at: at(2.7 * HOUR), content: [t('does the timeout reset after each recv or is it for the whole connection?')] },
        {
          role: 'assistant',
          at: at(2.7 * HOUR - 1_000),
          model: OPUS,
          content: [t('Each call. `settimeout(10)` gives every `recv` its own 10 seconds, so a client that sends a byte every 9 seconds never times out. For a limit on the whole connection, track a deadline yourself and pass the time left to `settimeout` before each `recv`.')],
        },
        { role: 'assistant', at: at(2.6 * HOUR), kind: 'aside', author: 'Second opinion', model: GPT, content: [t('Agree with both answers. One addition: set `SO_REUSEADDR` on the listening socket, or restarting the server during testing fails with "Address already in use" for about a minute.')] },
      ],
    },
    {
      session: chatSession({ id: 'c_immich', title: 'Immich moved to CT 115', model: SONNET, createdAt: at(26 * HOUR), updatedAt: at(26 * HOUR), chat: DEFAULTS }, 4),
      turns: [
        { role: 'user', at: at(26 * HOUR), content: [t("fyi I moved immich to CT 115 on madx, it's not on 105 anymore")] },
        {
          role: 'assistant',
          at: at(26 * HOUR - 1_000),
          model: SONNET,
          content: [
            { type: 'tool_use', id: 'tu_i1', name: 'MemorySearch', input: { query: 'immich container' } },
            { type: 'tool_use', id: 'tu_i2', name: 'MemoryForget', input: { id: 'mm_immich_old' } },
            { type: 'tool_use', id: 'tu_i3', name: 'MemorySave', input: { content: 'Immich (photos) runs in CT 115 on madx, data on tank/photos.', kind: 'fact' } },
          ],
        },
        {
          role: 'user',
          at: at(26 * HOUR - 2_000),
          content: [
            { type: 'tool_result', toolUseId: 'tu_i1', content: '1 memory:\n[mm_immich_old] Immich (photos) runs in CT 105 on madx, data on tank/photos.', meta: { durationMs: 180 } },
            { type: 'tool_result', toolUseId: 'tu_i2', content: 'Forgot memory mm_immich_old.', meta: { durationMs: 40 } },
            { type: 'tool_result', toolUseId: 'tu_i3', content: 'Saved memory mm12 (fact, global).', meta: { durationMs: 60, memoryId: 'mm12' } },
          ],
        },
        { role: 'assistant', at: at(26 * HOUR - 2_500), model: SONNET, content: [t('Saved: Immich runs in CT 115 on madx. I replaced the CT 105 note and kept `tank/photos` as its data location.')] },
      ],
    },
    {
      session: chatSession({ id: 'c_rack', title: 'Rack layout as an SVG', model: SONNET, createdAt: at(2 * DAY), updatedAt: at(2 * DAY - 5 * MIN), chat: { ...DEFAULTS, webSearch: false } }, 2),
      turns: [
        { role: 'user', at: at(2 * DAY), content: [t('draw my rack as a simple svg: pve at the top, the N100 PBS box under it, then the switch and the UPS at the bottom')] },
        {
          role: 'assistant',
          at: at(2 * DAY - 1_000),
          model: SONNET,
          content: [
            t(
              'Here it is, top to bottom as you listed:\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 200" font-family="sans-serif" font-size="12">\n  <rect x="20" y="10" width="200" height="180" fill="none" stroke="#888"/>\n  <rect x="30" y="20" width="180" height="34" fill="#ddd"/><text x="40" y="42">pve</text>\n  <rect x="30" y="62" width="180" height="34" fill="#ddd"/><text x="40" y="84">PBS, N100</text>\n  <rect x="30" y="104" width="180" height="22" fill="#ddd"/><text x="40" y="119">Switch</text>\n  <rect x="30" y="134" width="180" height="46" fill="#ddd"/><text x="40" y="161">UPS</text>\n</svg>\n```\n\nHeights are rough: 2U for pve, 2U for the PBS box, 1U for the switch, 3U for the UPS.',
            ),
          ],
        },
      ],
    },
    {
      session: chatSession({ id: 'c_pbs', title: 'When PBS verify jobs should run', model: GLM, createdAt: at(3 * DAY), updatedAt: at(3 * DAY - 10 * MIN), chat: DEFAULTS }, 2),
      turns: [
        { role: 'user', at: at(3 * DAY), content: [t('best time for the pbs verify job if backups run at 01:00 and take about an hour?')] },
        { role: 'assistant', at: at(3 * DAY - 1_000), model: GLM, content: [t('03:00, daily. That leaves an hour of slack after the backups and finishes before the 05:00 prune. Set "Skip verified" and "Re-verify after 30 days" so it only reads new snapshots each night.')] },
      ],
    },
    {
      session: chatSession({ id: 'c_csp', title: 'CSP nonces or hashes', model: OPUS, createdAt: at(6 * DAY), updatedAt: at(6 * DAY - 20 * MIN), chat: { ...DEFAULTS, thinking: 'high' } }, 2),
      turns: [
        { role: 'user', at: at(6 * DAY), content: [t('for SECU2002: when do you use a CSP nonce vs a hash for inline scripts?')] },
        {
          role: 'assistant',
          at: at(6 * DAY - 1_000),
          model: OPUS,
          content: [
            think('Nonce: per response, server renders HTML. Hash: static inline scripts that never change. Mention strict-dynamic briefly.', 9_800),
            t(
              'Use a **nonce** when the server renders each page, because it can put a fresh random value in the header and on every script tag. Use a **hash** when the inline script is static, such as a page served from a CDN, because the hash of the exact script text never changes.\n\n```http\nContent-Security-Policy: script-src \'nonce-4f9a1c2e\' \'strict-dynamic\'\n```\n\nA nonce must be new on every response; a reused nonce is as weak as `unsafe-inline`.',
            ),
          ],
        },
      ],
    },
    {
      session: chatSession({ id: 'c_gift', title: 'Gift ideas under 40 pounds', model: SONNET, createdAt: at(12 * DAY), updatedAt: at(12 * DAY - 6 * MIN), chat: { webSearch: true, memory: false } }, 2),
      turns: [
        { role: 'user', at: at(12 * DAY), content: [t('gift ideas for a friend who climbs and likes film photography, under 40 pounds')] },
        { role: 'assistant', at: at(12 * DAY - 1_000), model: SONNET, content: [t('A roll each of Portra 400 and HP5 with a prepaid development voucher from a local lab. It costs about 35 pounds, fits both hobbies on a trip to the crag, and feels more personal than gear they may already own.')] },
      ],
    },
    {
      session: chatSession({ id: 'c_page', title: 'A status page for the homelab', model: SONNET, createdAt: at(13 * DAY), updatedAt: at(13 * DAY - 4 * MIN), chat: DEFAULTS }, 2),
      turns: [
        { role: 'user', at: at(13 * DAY), content: [t('make me a tiny static html status page listing pve, pbs and caddy with a green or red word next to each')] },
        {
          role: 'assistant',
          at: at(13 * DAY - 1_000),
          model: SONNET,
          content: [
            t(
              'One file, no scripts. Edit the words by hand or let a cron job rewrite them:\n\n```html\n<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>madx status</title>\n  <style>\n    body { font: 15px system-ui, sans-serif; margin: 2rem; }\n    li { margin: .4rem 0; }\n    .up { color: #1a7f37; } .down { color: #cf222e; }\n  </style>\n</head>\n<body>\n  <h1>madx</h1>\n  <ul>\n    <li>pve <span class="up">up</span></li>\n    <li>pbs <span class="up">up</span></li>\n    <li>caddy <span class="down">down</span></li>\n  </ul>\n</body>\n</html>\n```',
            ),
          ],
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Live replies
// ---------------------------------------------------------------------------

interface Reply {
  thinking?: string;
  search?: { query: string; results: typeof CADDY_RESULTS };
  remember?: string;
  text: string;
  /** The provider refuses: the chat ends in the error state with this reason. */
  error?: string;
}

const KERNEL_RESULTS = [
  { title: 'Linux 6.18 released, LWN', url: 'https://lwn.net/Articles/1041120/', date: '2026-09-28' },
  { title: 'Arch Linux news: linux 6.18.1 in core', url: 'https://archlinux.org/news/', date: '2026-10-09' },
  { title: 'kernel.org releases', url: 'https://www.kernel.org/' },
];

function compose(prompt: string, s: ChatSettings): Reply {
  const p = prompt.toLowerCase();
  if (/\bfail\b/.test(p)) return { text: '', error: 'Anthropic did not accept its API key (anthropic 401 authentication_error: invalid x-api-key). Check the key in Settings, Providers, then retry.' };
  if (/\b(restart|run|install|ssh|deploy)\b.*\b(on|in)\b.*\b(madx|pve|arch|server|ct|lxc)\b/.test(p)) {
    return {
      thinking: s.thinking && s.thinking !== 'off' ? 'This needs a shell on the machine, and a chat has none. Say how, and point at Continue as a session.' : undefined,
      text: 'I cannot run commands from a chat. Here is what to run:\n\n```sh\nsudo systemctl restart caddy\nsystemctl status caddy --no-pager\n```\n\nContinue as a session moves this chat to an agent that can run them.',
    };
  }
  if (/\b(remember|fyi|moved|note that|save)\b/.test(p) && s.memory) {
    const fact = prompt.replace(/^(fyi|remember( that)?|note that|save( that)?)[:,]?\s*/i, '').replace(/\s+/g, ' ').trim();
    return { remember: fact.charAt(0).toUpperCase() + fact.slice(1), text: `Saved: ${fact}. Earlier notes that said otherwise are retired.` };
  }
  if (/\bsvg\b|diagram|draw/.test(p)) {
    return {
      thinking: s.thinking && s.thinking !== 'off' ? 'Keep the drawing small: boxes stacked top to bottom with labels, no colors that clash with the app theme.' : undefined,
      text: 'A first pass, boxes top to bottom:\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" font-family="sans-serif" font-size="12">\n  <rect x="10" y="10" width="220" height="30" fill="#ddd"/><text x="20" y="30">madx, the hub</text>\n  <rect x="10" y="48" width="220" height="30" fill="#ddd"/><text x="20" y="68">arch-desktop</text>\n  <rect x="10" y="86" width="220" height="24" fill="#ddd"/><text x="20" y="102">pve</text>\n</svg>\n```\n\nTell me what to add and I will redraw it.',
    };
  }
  if (/\bhtml\b|page\b/.test(p)) {
    return {
      text: 'A single file with no scripts:\n\n```html\n<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Notes</title>\n<style>body { font: 15px system-ui, sans-serif; margin: 2rem; max-width: 40rem; }</style></head>\n<body>\n  <h1>Notes</h1>\n  <p>Edit this text and open the file in a browser.</p>\n</body>\n</html>\n```',
    };
  }
  if (/^(hi|hey|hello|yo)\b/.test(p.trim())) return { text: 'Hey. What do you need?' };
  const thinking = s.thinking && s.thinking !== 'off' ? 'The answer depends on what changed recently, so check the current release before recommending anything. Memory says the desktop runs Arch, so answer for Arch.' : undefined;
  if (s.webSearch) {
    return {
      thinking,
      search: { query: 'linux 6.18 arch release', results: KERNEL_RESULTS },
      text: 'Linux 6.18 is out and Arch ships 6.18.1 in core ([Arch news](https://archlinux.org/news/)). Update with:\n\n```sh\nsudo pacman -Syu\n```\n\nThe RDNA3 resume bug from your notes is fixed in 6.18 ([LWN](https://lwn.net/Articles/1041120/)), so suspend should work again after a reboot.',
    };
  }
  return {
    thinking,
    text: 'Web search is off for this chat, so this is from what I already know: update with\n\n```sh\nsudo pacman -Syu\n```\n\nand reboot. Turn web search on if you want me to check the current release first.',
  };
}

function titleFrom(prompt: string): string {
  const words = prompt.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New chat';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerChat(ctx: MockCtx) {
  const { db, emit, uid, sleep } = ctx;

  if (!ctx.FRESH) {
    for (const { session, turns } of seeds(Date.now())) {
      db.sessions.set(session.id, session);
      db.messages.set(
        session.id,
        turns.map((m, i) => ({ id: `${session.id}_m${i}`, sessionId: session.id, seq: i + 1, role: m.role, kind: m.kind ?? 'normal', content: m.content, model: m.model, agent: m.role === 'assistant' ? 'chat' : undefined, author: m.author, createdAt: m.at, meta: m.meta, ...(m.role === 'assistant' ? { stopReason: 'end_turn' as const } : {}) })),
      );
    }
  }

  const isChat = (id: string) => db.sessions.get(id)?.kind === 'chat';
  const settings = (s: Session): ChatSettings => ({ ...DEFAULTS, ...(s.chat ?? {}) });
  const send = (e: EngineEvent) => emit(e);

  const nextSeq = (sessionId: string) => {
    const list = db.messages.get(sessionId) ?? [];
    return (list[list.length - 1]?.seq ?? 0) + 1;
  };
  const add = (m: Omit<Message, 'id' | 'seq' | 'createdAt'>): Message => {
    const full = { id: uid('m'), seq: nextSeq(m.sessionId), createdAt: Date.now(), ...m } as Message;
    const list = db.messages.get(m.sessionId) ?? [];
    list.push(full);
    db.messages.set(m.sessionId, list);
    send({ type: 'message.created', message: structuredClone(full) });
    return full;
  };
  const patch = (id: string, p: Partial<Session>) => {
    const s = db.sessions.get(id);
    if (!s) return undefined;
    Object.assign(s, p, { updatedAt: Date.now() });
    send({ type: 'session.updated', session: structuredClone(s) });
    return s;
  };

  /** Stream text into a block a few words at a time, at a believable pace. */
  async function stream(m: Message, kind: 'text' | 'thinking', body: string, signal: { stop: boolean }) {
    const index = m.content.length;
    const block: ContentBlock = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
    m.content.push(block);
    const started = Date.now();
    const parts = body.match(/\S+\s*|\s+/g) ?? [];
    let buf = '';
    for (let i = 0; i < parts.length && !signal.stop; i++) {
      buf += parts[i];
      if (buf.length < 8 && i < parts.length - 1) continue;
      if (block.type === 'text') block.text += buf;
      else if (block.type === 'thinking') block.thinking += buf;
      send({ type: 'message.delta', sessionId: m.sessionId, messageId: m.id, index, kind, text: buf });
      buf = '';
      await sleep(kind === 'thinking' ? 55 + Math.random() * 40 : 28 + Math.random() * 45);
    }
    if (block.type === 'thinking') block.durationMs = Date.now() - started + 600;
  }

  async function tool(sessionId: string, m: Message, name: string, input: Record<string, unknown>, result: { content: string; meta?: Record<string, unknown> }, delay: number, ask?: string) {
    const id = uid('tu');
    m.content.push({ type: 'tool_use', id, name, input });
    send({ type: 'tool.started', sessionId, messageId: m.id, toolUseId: id, name, input });
    send({ type: 'message.updated', message: structuredClone(m) });
    if (ask) {
      const answer = await ctx.requestApproval(sessionId, id, name, input, ask);
      patch(sessionId, { status: 'running' });
      if (answer.decision !== 'allow') result = { content: 'The user denied this action.' };
    }
    const started = Date.now();
    await sleep(delay);
    const block = { type: 'tool_result' as const, toolUseId: id, content: result.content, meta: { durationMs: Date.now() - started, ...result.meta } };
    send({ type: 'tool.completed', sessionId, toolUseId: id, result: block });
    add({ sessionId, role: 'user', kind: 'normal', content: [block] });
  }

  const running = new Map<string, { stop: boolean }>();

  async function reply(sessionId: string, prompt: string) {
    const s = db.sessions.get(sessionId);
    if (!s) return;
    const sw = settings(s);
    const signal = { stop: false };
    running.set(sessionId, signal);
    const first = s.stats.messages === 0;
    patch(sessionId, { status: 'running' });
    await sleep(350);
    const r = compose(prompt, sw);
    if (r.error) {
      await sleep(900);
      if (running.get(sessionId) !== signal) return;
      running.delete(sessionId);
      // the hub writes the reason as an error notice, then puts the chat in the error state
      add({ sessionId, role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Error: ${r.error}` }], meta: { level: 'error' } });
      patch(sessionId, { status: 'error', error: r.error });
      // as on the hub, what waited still runs after a failed turn
      void runNext(sessionId);
      return;
    }
    let m = add({ sessionId, role: 'assistant', kind: 'normal', content: [], model: s.model, agent: s.agent });
    if (r.thinking && !signal.stop) {
      await sleep(900);
      await stream(m, 'thinking', r.thinking, signal);
      send({ type: 'message.updated', message: structuredClone(m) });
    }
    if (sw.memory && r.remember && !signal.stop) {
      await tool(sessionId, m, 'MemorySearch', { query: r.remember.split(' ').slice(0, 3).join(' ') }, { content: '1 memory:\n[mm2] Desktop runs Arch Linux with Hyprland and zsh. Homelab is Proxmox VE 9 with PBS.' }, 300);
      const memoryId = uid('mm');
      await tool(sessionId, m, 'MemorySave', { content: r.remember, kind: 'fact' }, { content: `Saved memory ${memoryId} (fact, global).`, meta: { memoryId } }, 250);
      const saved: MemoryEntry = { id: memoryId, kind: 'fact', scope: 'global', content: r.remember, tags: [], importance: 0.5, useCount: 0, sourceSessionId: sessionId, createdAt: Date.now(), updatedAt: Date.now() };
      db.memories.set(saved.id, saved);
      send({ type: 'memory.updated', entry: saved });
      m = add({ sessionId, role: 'assistant', kind: 'normal', content: [], model: s.model, agent: s.agent });
    } else if (sw.webSearch && r.search && !signal.stop) {
      const ask = /\bask first\b/i.test(prompt) ? `A hook asks before each web search: ${r.search.query}` : undefined;
      await tool(sessionId, m, 'WebSearch', { query: r.search.query }, { content: `Web search results for "${r.search.query}" (via brave)`, meta: { provider: 'brave', count: r.search.results.length, results: r.search.results } }, 1_300, ask);
      m = add({ sessionId, role: 'assistant', kind: 'normal', content: [], model: s.model, agent: s.agent });
    }
    if (!signal.stop) await stream(m, 'text', r.text, signal);
    m.stopReason = signal.stop ? 'aborted' : 'end_turn';
    m.usage = { inputTokens: 3_400, outputTokens: 260, cacheReadTokens: 2_800 };
    // a rewind may have dropped this reply; then it says nothing more
    if ((db.messages.get(sessionId) ?? []).some((x) => x.id === m.id)) send({ type: 'message.updated', message: structuredClone(m) });
    // a newer reply took over (rewind, then a new message): leave the state to it
    if (running.get(sessionId) !== signal) return;
    running.delete(sessionId);
    const now = db.sessions.get(sessionId);
    if (!now) return;
    const msgs = (db.messages.get(sessionId) ?? []).filter((x) => x.kind === 'normal').length;
    patch(sessionId, { status: 'idle', error: undefined, stats: { ...now.stats, messages: msgs } });
    // the hub names a chat right after its first reply
    if (first && now.title === 'New chat') {
      await sleep(400);
      patch(sessionId, { title: titleFrom(prompt) });
    }
    // a message sent while this reply ran goes out now: the hub writes it when its turn starts
    if (!signal.stop) void runNext(sessionId);
  }

  /** The next message that waited, written in place of its bubble (meta.pendingIds), then its reply. */
  async function runNext(sessionId: string) {
    if (!ctx.waiting.next(sessionId)) return;
    // as on the hub: the turn starts (hooks, recall) before it stores the message, which stays listed until then
    patch(sessionId, { status: 'running' });
    await sleep(300);
    const next = ctx.waiting.next(sessionId);
    if (!next) return patch(sessionId, { status: 'idle' });
    userMessage(sessionId, next.text, next.input.attachments, { pendingIds: [next.id], whenBusy: 'queue' });
    ctx.waiting.done(sessionId, [next.id]);
    void reply(sessionId, next.text);
  }

  type Attachments = Array<{ mediaType?: string; data?: string; name?: string }>;

  function userMessage(sessionId: string, text: string, attachments: Attachments = [], extra?: Record<string, unknown>) {
    const s = db.sessions.get(sessionId);
    const content: ContentBlock[] = [{ type: 'text', text }];
    for (const a of attachments) {
      if (a.mediaType?.startsWith('image/')) content.push({ type: 'image', mediaType: a.mediaType, data: a.data });
      else content.push({ type: 'document', mediaType: a.mediaType ?? 'application/octet-stream', data: a.data, title: a.name });
    }
    const recalled = s && settings(s).memory && /madx|arch|caddy|uni|comp|pbs|pve/i.test(text) ? ['mm2', 'mm5'] : undefined;
    // like the hub: the recalled notes ride on the message as a reminder for the model (never shown, never resent)
    if (recalled) content.push(recallReminder(recalled));
    const meta = { ...(recalled ? { recalled } : {}), ...extra };
    return add({ sessionId, role: 'user', kind: 'normal', content, meta: Object.keys(meta).length ? meta : undefined });
  }

  // chats only, or everything but chats; archived as before
  ctx.on('GET', '/api/sessions', ({ query }) => {
    const archived = query.get('archived') === 'true';
    const kind = query.get('kind');
    if (kind && kind !== 'chat' && kind !== 'agent') ctx.fail(400, 'kind must be one of agent, chat');
    return [...db.sessions.values()]
      .filter((s) => s.archived === archived)
      .filter((s) => (kind === 'chat' ? s.kind === 'chat' : kind === 'agent' ? s.kind !== 'chat' : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ctx.on('POST', '/api/sessions', ({ body }) => {
    if (body?.kind !== 'chat') return ctx.pass;
    for (const k of ['webSearch', 'memory'] as const) if (body.chat?.[k] !== undefined && typeof body.chat[k] !== 'boolean') ctx.fail(400, `chat.${k} must be true or false`);
    if (body.chat?.thinking != null && !isEffortSetting(body.chat.thinking)) ctx.fail(400, 'chat.thinking must be off, low, medium, high, xhigh or max');
    const now = Date.now();
    const chat: ChatSettings = { ...DEFAULTS, ...(body.chat ?? {}) };
    if (chat.thinking === null) delete chat.thinking;
    const s: Session = {
      id: uid('c'),
      title: body.title ?? 'New chat',
      agent: body.agent ?? 'chat',
      model: body.model ?? SONNET,
      mode: 'agent',
      permissionMode: 'default',
      cwd: '~',
      device: 'local',
      status: 'idle',
      tags: body.tags ?? [],
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      kind: 'chat',
      chat,
    };
    db.sessions.set(s.id, s);
    db.messages.set(s.id, []);
    send({ type: 'session.created', session: structuredClone(s) });
    if (body.prompt) {
      setTimeout(() => {
        userMessage(s.id, body.prompt);
        void reply(s.id, body.prompt);
      }, 50);
    }
    return s;
  });

  ctx.on('PATCH', '/api/sessions/:id', ({ params, body }) => {
    const s = db.sessions.get(params[0]);
    if (!s || s.kind !== 'chat') return ctx.pass;
    const { chat, kind, ...rest } = body ?? {};
    if (kind !== undefined && kind !== 'chat' && kind !== 'agent') ctx.fail(400, 'kind must be chat or agent');
    if (chat?.thinking !== undefined && chat.thinking !== null && !isEffortSetting(chat.thinking)) ctx.fail(400, 'chat.thinking must be off, low, medium, high, xhigh or max');
    for (const k of ['webSearch', 'memory'] as const) if (chat?.[k] !== undefined && typeof chat[k] !== 'boolean') ctx.fail(400, `chat.${k} must be true or false`);
    const next: ChatSettings = { ...settings(s), ...(chat ?? {}) };
    if (chat?.thinking === null) delete next.thinking;
    if (rest.taskId === null) rest.taskId = undefined;
    Object.assign(s, rest);
    if (kind === 'agent') {
      // Continue as a session: the chat moves to Sessions with its transcript
      delete s.kind;
      delete s.chat;
    } else s.chat = next;
    return patch(s.id, {});
  });

  ctx.on('POST', '/api/sessions/:id/messages', ({ params, body }) => {
    const s = db.sessions.get(params[0]);
    if (!s || s.kind !== 'chat') return ctx.pass;
    const text = String(body?.text ?? '');
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    // while a reply runs the hub holds the message, lists it (session.queue), and writes it when its turn starts
    if (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input') return ctx.waiting.wait(s.id, { ...body, text, attachments });
    const m = userMessage(s.id, text, attachments);
    void reply(s.id, text);
    return { queued: false, messageId: m.id };
  });

  // Send on a message Stop held: it runs now when no reply runs
  ctx.on('POST', '/api/sessions/:id/queue/:pending/send', ({ params }) => {
    if (!isChat(params[0])) return ctx.pass;
    if (!ctx.waiting.release(params[0], decodeURIComponent(params[1]))) return ctx.fail(404, 'That message is not waiting any more.');
    if (!running.has(params[0])) void runNext(params[0]);
    return { ok: true };
  });

  ctx.on('POST', '/api/sessions/:id/abort', ({ params }) => {
    if (!isChat(params[0])) return ctx.pass;
    const r = running.get(params[0]);
    ctx.waiting.hold(params[0]);
    // nothing running: nothing to stop, and no notice (as on the hub)
    if (!r) return { ok: true };
    r.stop = true;
    running.delete(params[0]);
    // the hub's words; the Chat page reads them as "Stopped by you."
    add({ sessionId: params[0], role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Stopped' }], meta: { level: 'info' } });
    patch(params[0], { status: 'idle' });
    return { ok: true };
  });

  // As on the hub: the reviewer answers in one go, then the call returns. The aside names no
  // reply (the page remembers which one it asked about) and a notice says it was added.
  ctx.on('POST', '/api/sessions/:id/second-opinion', async ({ params, body }) => {
    const s = db.sessions.get(params[0]);
    if (!s || s.kind !== 'chat') return ctx.pass;
    const reviewer = body?.reviewer ?? GPT;
    const list = db.messages.get(s.id) ?? [];
    const target = typeof body?.messageId === 'string' ? list.find((m) => m.id === body.messageId) : [...list].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal');
    if (!target) {
      add({ sessionId: s.id, role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Nothing to review yet.' }], meta: { level: 'warning' } });
      return { ok: true };
    }
    await sleep(1_600);
    const text = 'Mostly right. One thing to check first: the answer assumes the default config path. On your setup the file may live somewhere else, so confirm the path before you edit it.';
    add({ sessionId: s.id, role: 'assistant', kind: 'aside', content: [{ type: 'text', text }], model: reviewer, author: 'Second opinion', meta: { messageId: target.id } });
    add({ sessionId: s.id, role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Second opinion from ${reviewer} added.` }], meta: { level: 'success' } });
    return { ok: true };
  });

  // Edit and Retry: the hub keeps messages up to `seq` and drops the rest (truncateAfter)
  ctx.on('POST', '/api/sessions/:id/rewind', ({ params, body }) => {
    const s = db.sessions.get(params[0]);
    if (!s || s.kind !== 'chat') return ctx.pass;
    if (typeof body?.seq !== 'number') ctx.fail(400, 'seq is required');
    const r = running.get(s.id);
    if (r) r.stop = true;
    // a rewind stops, so what waits is held, as on the hub
    ctx.waiting.hold(s.id);
    const list = (db.messages.get(s.id) ?? []).filter((m) => m.seq <= body.seq);
    db.messages.set(s.id, list);
    return patch(s.id, { status: 'idle', error: undefined, stats: { ...s.stats, messages: list.length } });
  });

  // the Chat page greets the owner by name (ui.name, set in Settings > Appearance)
  const ui = db.config.ui as Record<string, unknown> | undefined;
  if (!ctx.FRESH && ui && ui.name === undefined) ui.name = 'Kai';
}
