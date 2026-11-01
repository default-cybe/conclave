/**
 * Mock of a chat whose assistant uses the hub's browser, and the live view
 * routes (routes-browser.ts, /api/browser/sessions/:session): the line above
 * the composer, Watch, Take over and Give back (features/chat/BrowserLive.tsx).
 * The frame is a shop page drawn on a canvas and sent as a real JPEG; a click
 * while held marks the spot, so the screenshots show input landing.
 *
 *   /c/c_browse   the chat, its page open on the hub
 */
import type { BrowserLiveDto, SignInFrameDto } from '@conclave/core/client';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import type { MockCtx } from './index';

const SID = 'c_browse';
const URL_NOW = 'https://www.shop.example/headphones/sony-wh-1000xm6';
const W = 1280;
const H = 800;
const MIN = 60_000;

function draw(clicks: Array<{ x: number; y: number }>): string {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d2b3a';
  g.fillRect(0, 0, W, 64);
  g.fillStyle = '#ffffff';
  g.font = 'bold 24px Helvetica, Arial';
  g.fillText('shop.example', 32, 41);
  g.font = '16px Helvetica, Arial';
  g.fillText('Audio   Phones   Laptops   Deals', 820, 40);
  g.fillStyle = '#eef1f4';
  g.fillRect(64, 112, 520, 520);
  g.fillStyle = '#2b2f36';
  g.beginPath();
  g.arc(324, 360, 150, Math.PI, 0);
  g.lineWidth = 26;
  g.strokeStyle = '#2b2f36';
  g.stroke();
  g.fillRect(150, 350, 70, 130);
  g.fillRect(428, 350, 70, 130);
  g.fillStyle = '#1d2b3a';
  g.font = 'bold 34px Helvetica, Arial';
  g.fillText('Sony WH-1000XM6', 640, 170);
  g.font = '18px Helvetica, Arial';
  g.fillStyle = '#5a6572';
  g.fillText('Wireless noise cancelling headphones, black', 640, 206);
  g.fillStyle = '#b3261e';
  g.font = 'bold 44px Helvetica, Arial';
  g.fillText('$379.00', 640, 290);
  g.fillStyle = '#5a6572';
  g.font = '18px Helvetica, Arial';
  g.fillText('In stock. Ships tomorrow.', 640, 330);
  g.fillStyle = '#f0b400';
  g.fillRect(640, 380, 300, 60);
  g.fillStyle = '#1d2b3a';
  g.font = 'bold 20px Helvetica, Arial';
  g.fillText('Add to cart', 732, 417);
  g.strokeStyle = '#c7ced6';
  g.lineWidth = 2;
  g.strokeRect(640, 460, 300, 60);
  g.fillText('Check postcode', 718, 497);
  for (const p of clicks) {
    g.strokeStyle = '#2f6fde';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(p.x, p.y, 18, 0, Math.PI * 2);
    g.stroke();
  }
  return c.toDataURL('image/jpeg', 0.7).split(',')[1] ?? '';
}

export function registerBrowserLive(ctx: MockCtx) {
  const { on, fail, db, FRESH } = ctx;
  if (FRESH) return;
  const now = Date.now();
  const session = {
    id: SID,
    title: 'Price of the Sony XM6',
    agent: 'chat',
    kind: 'chat',
    model: 'anthropic/claude-sonnet-5-5',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: now - 6 * MIN,
    updatedAt: now - MIN,
    stats: { messages: 4, inputTokens: 12_000, outputTokens: 900, cacheReadTokens: 8_000, costUsd: 0.03 },
  } as unknown as Session;
  const msg = (i: number, role: Message['role'], content: ContentBlock[], at: number): Message =>
    ({ id: `${SID}_m${i}`, sessionId: SID, seq: i + 1, role, kind: 'normal', content, createdAt: at, ...(role === 'assistant' ? { model: session.model, agent: 'chat', stopReason: 'end_turn' } : {}) }) as Message;
  db.sessions.set(SID, session);
  db.messages.set(SID, [
    msg(0, 'user', [{ type: 'text', text: 'what does shop.example want for the sony xm6 right now?' }], now - 6 * MIN),
    msg(1, 'assistant', [{ type: 'tool_use', id: 'tu_br_nav', name: 'browser_navigate', input: { url: URL_NOW } }], now - 6 * MIN + 2_000),
    msg(2, 'user', [{ type: 'tool_result', toolUseId: 'tu_br_nav', content: `Loaded ${URL_NOW}\nSony WH-1000XM6, $379.00, In stock.` }], now - 6 * MIN + 5_000),
    msg(3, 'assistant', [{ type: 'text', text: 'shop.example has the **Sony WH-1000XM6** at **$379.00**, in stock and shipping tomorrow. The page is still open if you want to look or check your postcode yourself.' }], now - MIN),
  ]);

  let held = false;
  let seq = 0;
  let frame: SignInFrameDto | undefined;
  const clicks: Array<{ x: number; y: number }> = [];
  const dto = (): BrowserLiveDto => ({ open: true, held, profile: 'default', url: URL_NOW });
  const known = (id: string) => (id === SID ? id : fail(404, 'This session has no browser page open.'));

  on('GET', '/api/browser/sessions/:id', ({ params }) => (params[0] === SID ? dto() : { open: false, held: false }));
  on('GET', '/api/browser/sessions/:id/frame', ({ params, query }) => {
    known(params[0]);
    if (!frame) frame = { seq: ++seq, url: URL_NOW, width: W, height: H, data: draw(clicks) };
    return frame.seq > Number(query.get('after') ?? 0) ? frame : undefined;
  });
  on('DELETE', '/api/browser/sessions/:id/frame', ({ params }) => {
    known(params[0]);
    held = false;
    return { ok: true };
  });
  on('POST', '/api/browser/sessions/:id/input', ({ params, body }) => {
    known(params[0]);
    if (!held) fail(409, 'Take over first: the assistant is using this browser.');
    for (const ev of (body as { events?: Array<{ type: string; action?: string; x?: number; y?: number }> }).events ?? []) {
      if (ev.type === 'mouse' && ev.action === 'down' && ev.x !== undefined && ev.y !== undefined) clicks.push({ x: ev.x, y: ev.y });
    }
    frame = undefined;
    return { ok: true };
  });
  on('POST', '/api/browser/sessions/:id/control', ({ params, body }) => {
    known(params[0]);
    held = !!(body as { take?: boolean }).take;
    return dto();
  });
}
