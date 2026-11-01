/** Serializable takeover input and its mapping to CDP Input.* commands. */

export type MouseButton = 'left' | 'middle' | 'right';

/**
 * One input event from a remote viewer. Coordinates are CSS pixels in the
 * same space as the screencast frame's width and height.
 */
export type BrowserInputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: MouseButton; deltaX?: number; deltaY?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; text?: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'resize'; width: number; height: number };

/** One CDP command to send. */
export interface CdpCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText';
  params: Record<string, unknown>;
}

const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
};

/** Windows virtual key code, which Chromium needs for non-text keys to act. */
export function keyCodeFor(key: string, code?: string): number {
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return c;
  }
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
  const f = /^F(\d{1,2})$/.exec(key);
  if (f) return 111 + Number(f[1]);
  if (code) {
    const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(code);
    if (m) return m[1] ? m[1].charCodeAt(0) : m[2] ? 48 + Number(m[2]) : 96 + Number(m[3]);
  }
  return 0;
}

/**
 * Per-viewer state: held modifiers, held buttons and click counting so
 * double clicks work from a phone or the web UI.
 */
export class InputState {
  modifiers = 0;
  buttons = 0;
  private lastDown = { t: 0, x: 0, y: 0, button: '' as string, count: 0 };

  /** CDP commands for a mouse, key or text event. Navigate and resize are handled by the caller. */
  toCdp(ev: BrowserInputEvent): CdpCommand[] {
    if (ev.type === 'text') return ev.text ? [{ method: 'Input.insertText', params: { text: ev.text } }] : [];
    if (ev.type === 'mouse') return [this.mouse(ev)];
    if (ev.type === 'key') return [this.key(ev)];
    return [];
  }

  private mouse(ev: Extract<BrowserInputEvent, { type: 'mouse' }>): CdpCommand {
    const x = Number(ev.x) || 0;
    const y = Number(ev.y) || 0;
    const button: MouseButton = ev.button ?? 'left';
    const base = { x, y, modifiers: this.modifiers };
    if (ev.action === 'wheel') {
      return {
        method: 'Input.dispatchMouseEvent',
        params: { ...base, type: 'mouseWheel', deltaX: Number(ev.deltaX) || 0, deltaY: Number(ev.deltaY) || 0 },
      };
    }
    if (ev.action === 'move') {
      const held = (Object.keys(BUTTON_BITS) as MouseButton[]).find((b) => this.buttons & BUTTON_BITS[b]);
      return {
        method: 'Input.dispatchMouseEvent',
        params: { ...base, type: 'mouseMoved', button: held ?? 'none', buttons: this.buttons },
      };
    }
    if (ev.action === 'down') {
      const now = Date.now();
      const d = this.lastDown;
      const near = Math.abs(d.x - x) < 6 && Math.abs(d.y - y) < 6;
      d.count = near && d.button === button && now - d.t < 500 ? Math.min(d.count + 1, 3) : 1;
      Object.assign(d, { t: now, x, y, button });
      this.buttons |= BUTTON_BITS[button];
      return {
        method: 'Input.dispatchMouseEvent',
        params: { ...base, type: 'mousePressed', button, buttons: this.buttons, clickCount: d.count },
      };
    }
    this.buttons &= ~BUTTON_BITS[button];
    return {
      method: 'Input.dispatchMouseEvent',
      params: { ...base, type: 'mouseReleased', button, buttons: this.buttons, clickCount: this.lastDown.count || 1 },
    };
  }

  private key(ev: Extract<BrowserInputEvent, { type: 'key' }>): CdpCommand {
    const vk = keyCodeFor(ev.key, ev.code);
    const bit = MOD_BITS[ev.key] ?? 0;
    if (ev.action === 'down') {
      this.modifiers |= bit;
      // Ctrl/Meta chords are shortcuts, not text.
      const chord = (this.modifiers & (MOD_BITS.Control | MOD_BITS.Meta)) !== 0;
      const text = chord ? undefined : ev.text ?? (ev.key.length === 1 ? ev.key : ev.key === 'Enter' ? '\r' : undefined);
      return {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: text ? 'keyDown' : 'rawKeyDown',
          key: ev.key,
          code: ev.code ?? '',
          text,
          unmodifiedText: text,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          modifiers: this.modifiers,
        },
      };
    }
    const mods = this.modifiers;
    this.modifiers &= ~bit;
    return {
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: ev.key, code: ev.code ?? '', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods },
    };
  }
}

/** Shape check for events that arrive over the wire. Returns an error message or undefined. */
export function validateInputEvent(ev: unknown): string | undefined {
  if (!ev || typeof ev !== 'object') return 'event must be an object';
  const e = ev as Record<string, unknown>;
  const num = (k: string) => typeof e[k] === 'number' && Number.isFinite(e[k] as number);
  switch (e.type) {
    case 'mouse':
      if (!['move', 'down', 'up', 'wheel'].includes(e.action as string)) return 'bad mouse action';
      if (!num('x') || !num('y')) return 'mouse needs numeric x and y';
      if (e.button !== undefined && !['left', 'middle', 'right'].includes(e.button as string)) return 'bad mouse button';
      return undefined;
    case 'key':
      if (!['down', 'up'].includes(e.action as string)) return 'bad key action';
      return typeof e.key === 'string' && e.key ? undefined : 'key needs a key name';
    case 'text':
      return typeof e.text === 'string' ? undefined : 'text needs a string';
    case 'navigate':
      return typeof e.url === 'string' && e.url ? undefined : 'navigate needs a url';
    case 'resize':
      return num('width') && num('height') ? undefined : 'resize needs numeric width and height';
    default:
      return 'unknown event type';
  }
}
