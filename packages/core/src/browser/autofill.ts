/**
 * Filling a saved login into a page (browser_login). This is hub code, not
 * page code the model wrote:
 *
 * - It looks only at the tab's own document (and its open shadow roots),
 *   never into a frame, so a frame from another site gets nothing.
 * - Before every fill it checks the tab's top-level origin against the
 *   saved site (logins.ts originMatches), and the form's target too, so a
 *   form that sends somewhere else is not filled.
 * - The password goes only into an <input type=password>, and only on a page
 *   with one password field: a form to make or change a password is refused.
 * - Values are set with the page's own input setter plus input and change
 *   events, so the site's scripts see them. The password is an argument of
 *   one evaluate, never of locator.fill: Playwright writes fill's value into
 *   its call log, which ends up in error messages.
 * - After the submit, a password field that still holds the password is
 *   cleared, so nothing later in the session can read it from the page.
 */
import type { ElementHandle, JSHandle, Page } from 'playwright-core';
import { originMatches, parseTotp, siteHost, totpCode, type SavedLogin } from './logins';

/** A refusal the model should read as is: nothing was filled. */
export class LoginRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginRefused';
  }
}

export interface LoginFields {
  user?: ElementHandle<HTMLInputElement>;
  password?: ElementHandle<HTMLInputElement>;
  code?: ElementHandle<HTMLInputElement>;
  /** One box per digit, in order, when the site splits the code. */
  codeBoxes: ElementHandle<HTMLInputElement>[];
  submit?: ElementHandle<HTMLElement>;
  /** Where the form sends: a submit button's formaction, the form's action, or the page. */
  action: string;
  /** Visible password fields on the page. */
  passwords: number;
}

export interface FillPlan {
  page: Page;
  login: SavedLogin;
  password: string;
  totp?: string;
  /** Runs a step that may load a page and waits for it (BrowserManager.withSettle). */
  settle: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Asks the owner for a sign-in code. undefined: they would rather sign in themselves. */
  askCode?: (q: { host: string; username: string }) => Promise<string | undefined>;
}

export interface FillOutcome {
  filled: Array<'username' | 'password' | 'code'>;
  submitted: boolean;
  /** The page still shows a password field at the end. */
  stillAsking: boolean;
  /** How a request for a code went: the saved 2FA key, the owner typed it, or no code (the owner will sign in themselves). */
  code?: 'totp' | 'owner' | 'declined';
  url: string;
}

const SCAN_MS = 10_000;
const FILL_MS = 10_000;
const NEXT_STEP_MS = 10_000;

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`The page did not answer in time (${what}).`)), ms)))]).finally(() => clearTimeout(timer));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** Runs in the page: the login form's fields. Self-contained, since it is sent to the page as source. */
const scanPage = () => {
  const inputs: HTMLInputElement[] = [];
  const buttons: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el instanceof HTMLInputElement) inputs.push(el);
      else if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button') buttons.push(el as HTMLElement);
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) walk(shadow);
    }
  };
  walk(document);
  const attr = (el: Element, name: string) => Element.prototype.getAttribute.call(el, name);
  const shown = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const usable = (i: HTMLInputElement) => shown(i) && !i.disabled && !i.readOnly;
  const words = (i: HTMLInputElement) => {
    const labels = i.labels ? Array.from(i.labels, (l) => l.textContent ?? '').join(' ') : '';
    return [attr(i, 'name'), attr(i, 'id'), attr(i, 'placeholder'), attr(i, 'aria-label'), attr(i, 'autocomplete'), labels].join(' ').toLowerCase();
  };
  const textish = (i: HTMLInputElement) => i.type === 'text' || i.type === 'email' || i.type === 'tel' || i.type === 'number';
  const pick = (list: HTMLInputElement[], score: (i: HTMLInputElement) => number, last: boolean) => {
    let best: HTMLInputElement | undefined;
    let top = -Infinity;
    for (const i of list) {
      const s = score(i);
      if (s > top || (last && s === top)) {
        best = i;
        top = s;
      }
    }
    return { best, top };
  };
  const live = inputs.filter(usable);
  const pws = live.filter((i) => i.type === 'password');
  const pw = pws.length === 1 ? pws[0] : undefined;
  const userScore = (i: HTMLInputElement) => {
    const w = words(i);
    const ac = (attr(i, 'autocomplete') ?? '').toLowerCase();
    if (/search|query|captcha|one-time|otp|verification|coupon|promo/.test(w)) return -1;
    if (/\busername\b/.test(ac) || ac === 'email') return 5;
    if (i.type === 'email') return 4;
    if (/user|e-?mail|login|account|phone|mobile|identifier|handle/.test(w)) return 3;
    return 0;
  };
  let user: HTMLInputElement | undefined;
  if (pw) {
    const prior = live.filter((i) => textish(i) && !!(i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING));
    const same = prior.filter((i) => !!i.form && i.form === pw.form);
    const r = pick(same.length ? same : prior, (i) => userScore(i) + (i.form && i.form === pw.form ? 1 : 0), true);
    if (r.best && r.top >= 1) user = r.best;
  } else {
    const r = pick(live.filter(textish), userScore, false);
    if (r.best && r.top >= 3) user = r.best;
  }
  let code: HTMLInputElement | undefined;
  let boxes: HTMLInputElement[] = [];
  if (!pw) {
    const codeScore = (i: HTMLInputElement) => {
      if (!textish(i)) return -1;
      if ((attr(i, 'autocomplete') ?? '').toLowerCase() === 'one-time-code') return 5;
      return /otp|one.?time|2fa|two.?factor|totp|mfa|verif|security.?code|auth\w*.?code|passcode|\bcode\b|\bpin\b/.test(words(i)) ? 3 : 0;
    };
    const r = pick(live, codeScore, false);
    if (r.best && r.top >= 3 && (!user || r.top === 5 || r.best === user)) {
      code = r.best;
      if (code === user) user = undefined;
      if (code.maxLength === 1) {
        const scope: ParentNode = code.form ?? code.parentElement?.parentElement ?? document;
        boxes = live.filter((i) => textish(i) && i.maxLength === 1 && scope.contains(i));
        if (boxes.length < 4) boxes = [];
      }
    }
  }
  const target = pw ?? user ?? code;
  const form = target?.form ?? null;
  const LABEL = /^(log ?in|log ?on|sign ?in|continue|next|submit|verify|confirm|ok|weiter|anmelden|einloggen|se connecter|connexion|iniciar sesi[oó]n|entrar|accedi|inloggen)$/i;
  const label = (b: HTMLElement) => ((b instanceof HTMLInputElement ? b.value : b.textContent) ?? '').trim().replace(/\s+/g, ' ');
  const enabled = (b: HTMLElement) => shown(b) && !(b as HTMLButtonElement).disabled;
  let submit: HTMLElement | undefined;
  if (form) {
    submit = [...buttons, ...inputs].find(
      (b) => (b instanceof HTMLButtonElement && b.type === 'submit' && b.form === form && enabled(b)) || (b instanceof HTMLInputElement && (b.type === 'submit' || b.type === 'image') && b.form === form && enabled(b)),
    );
  }
  if (!submit && target) submit = [...buttons, ...inputs.filter((i) => i.type === 'submit' || i.type === 'button')].find((b) => enabled(b) && LABEL.test(label(b)));
  // where it sends; read with Element's own getAttribute, so a field named "action" cannot stand in for it
  let action = location.href;
  const owner = submit && (submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) ? submit.form : null;
  if (submit && owner && attr(submit, 'formaction')) action = new URL(attr(submit, 'formaction')!, document.baseURI).href;
  else if (owner ?? form) {
    const a = attr((owner ?? form)!, 'action');
    if (a) action = new URL(a, document.baseURI).href;
  }
  return { user, password: pw, code, codeBoxes: boxes, submit, action, passwords: pws.length };
};

/** The login form's fields in the tab's own document. */
export async function readFields(page: Page): Promise<LoginFields> {
  let root: JSHandle;
  try {
    root = await within(SCAN_MS, page.mainFrame().evaluateHandle(scanPage), 'reading the login form');
  } catch {
    // a page that is still loading: once more after it settles
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    root = await within(SCAN_MS, page.mainFrame().evaluateHandle(scanPage), 'reading the login form');
  }
  try {
    const el = async <T extends Node>(key: string) => ((await root.getProperty(key)).asElement() ?? undefined) as ElementHandle<T> | undefined;
    const boxes = [...(await (await root.getProperty('codeBoxes')).getProperties()).entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, h]) => h.asElement())
      .filter((h): h is ElementHandle<Node> => !!h) as ElementHandle<HTMLInputElement>[];
    return {
      user: await el<HTMLInputElement>('user'),
      password: await el<HTMLInputElement>('password'),
      code: await el<HTMLInputElement>('code'),
      codeBoxes: boxes,
      submit: await el<HTMLElement>('submit'),
      action: String(await (await root.getProperty('action')).jsonValue()),
      passwords: Number(await (await root.getProperty('passwords')).jsonValue()),
    };
  } finally {
    void root.dispose().catch(() => {});
  }
}

/** Read the fields until `want` holds or `ms` passes; the last read either way. */
async function waitFields(page: Page, want: (f: LoginFields) => boolean, ms: number): Promise<LoginFields> {
  const deadline = Date.now() + ms;
  let last: LoginFields = { codeBoxes: [], action: '', passwords: 0 };
  for (;;) {
    try {
      last = await readFields(page);
      if (want(last)) return last;
    } catch {
      /* a navigation between reads */
    }
    if (Date.now() >= deadline || page.isClosed()) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Set a field's value the way the site's scripts see typing: the input
 * setter, then input and change events. Refuses unless the field is still in
 * the page at `origin`, and the password only into a password field.
 */
export async function setInputValue(el: ElementHandle<HTMLInputElement>, value: string, opts: { origin: string; password?: boolean }): Promise<void> {
  let ok = false;
  try {
    ok = await within(
      FILL_MS,
      el.evaluate(
        (node, [v, origin, pw]) => {
          if (!(node instanceof HTMLInputElement) || !node.isConnected || location.origin !== origin) return false;
          if ((node.type === 'password') !== pw) return false;
          node.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, v);
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        [value, opts.origin, !!opts.password] as [string, string, boolean],
      ),
      'filling the form',
    );
  } catch {
    ok = false;
  }
  // never the page's own error: it could quote the value
  if (!ok) throw new LoginRefused(`The hub could not fill the ${opts.password ? 'password' : 'login'} field: the page changed. Take a browser_snapshot and try again.`);
}

/** Press the form's button, or Enter in the field. */
async function submitFrom(f: LoginFields, from: ElementHandle<HTMLInputElement>): Promise<void> {
  if (f.submit) {
    try {
      await f.submit.click({ timeout: 5_000 });
      return;
    } catch {
      /* covered or gone: Enter in the field instead */
    }
  }
  await from.press('Enter', { timeout: 5_000 }).catch(() => {});
}

/** Clear every password field of the tab's own document that still holds the password. */
export async function clearPasswordFields(page: Page, secret: string, origin: string): Promise<number> {
  try {
    return await within(
      FILL_MS,
      page.mainFrame().evaluate(
        ([s, o]) => {
          if (location.origin !== o) return 0;
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
          let n = 0;
          const walk = (root: Document | ShadowRoot) => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              if (el instanceof HTMLInputElement && el.type === 'password' && el.value === s) {
                set.call(el, '');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                n++;
              }
              const shadow = (el as HTMLElement).shadowRoot;
              if (shadow) walk(shadow);
            }
          };
          walk(document);
          return n;
        },
        [secret, origin] as [string, string],
      ),
      'clearing the password field',
    );
  } catch {
    return 0;
  }
}

/** The form must send to the saved site (or this page's own origin). */
function checkAction(f: LoginFields, login: SavedLogin, pageUrl: string): void {
  const a = f.action;
  if (!a || /^javascript:/i.test(a) || a === 'about:blank') return;
  let u: URL;
  try {
    u = new URL(a);
  } catch {
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LoginRefused(`The login form on this page sends to a ${u.protocol} address. The hub did not fill it.`);
  if (u.origin === new URL(pageUrl).origin || originMatches(login, a)) return;
  throw new LoginRefused(`The login form on this page sends to ${u.hostname}, not ${siteHost(login.origin)}. The hub did not fill it.`);
}

/**
 * Fill and submit the saved login on the tab: username and password (on one
 * page, or the username first and the password on the next), then a code
 * when the site asks for one. Throws LoginRefused before anything is filled
 * when the tab is not on the saved site or the form is not a login form.
 */
export async function fillSavedLogin(plan: FillPlan): Promise<FillOutcome> {
  const { page, login } = plan;
  const host = siteHost(login.origin);
  const here = () => page.url();
  /** The tab's origin, after checking it is the saved site's. */
  const onSite = (): string => {
    const url = here();
    if (!originMatches(login, url)) throw new LoginRefused(`This tab is on ${hostOf(url)}, not ${host}. The hub fills a saved login only on the site it was saved for. Open ${login.origin} first.`);
    return new URL(url).origin;
  };
  const loginForm = (f: LoginFields) => {
    if (f.passwords > 1) throw new LoginRefused('This page has more than one password field: a form to make or change a password. The hub fills only login forms.');
    checkAction(f, login, here());
  };
  const out: FillOutcome = { filled: [], submitted: false, stillAsking: false, url: here() };

  let origin = onSite();
  let f = await readFields(page);
  if (!f.password && !f.user && !f.code) throw new LoginRefused(`No login form on this page (${here()}). Open the site's login page, then call browser_login again.`);
  loginForm(f);

  const codeStep = async (fields: LoginFields): Promise<void> => {
    let code: string | undefined;
    if (plan.totp) {
      code = totpCode(parseTotp(plan.totp));
      out.code = 'totp';
    } else {
      code = (await plan.askCode?.({ host, username: login.username }))?.trim() || undefined;
      out.code = code ? 'owner' : 'declined';
    }
    if (!code) return;
    // the owner may have taken a while: read the page again
    const o = onSite();
    let now = out.code === 'owner' ? await readFields(page) : fields;
    if (!now.code) now = await waitFields(page, (x) => !!x.code, 3_000);
    if (!now.code || now.password) return;
    loginForm(now);
    if (now.codeBoxes.length >= code.length) {
      for (let i = 0; i < code.length; i++) await setInputValue(now.codeBoxes[i], code[i], { origin: o });
    } else await setInputValue(now.code, code, { origin: o });
    out.filled.push('code');
    await plan.settle(() => submitFrom(now, now.code!));
  };

  if (f.password || f.user) {
    if (f.user) {
      await setInputValue(f.user, login.username, { origin });
      out.filled.push('username');
    }
    if (f.password) {
      await setInputValue(f.password, plan.password, { origin, password: true });
      out.filled.push('password');
      await plan.settle(() => submitFrom(f, f.password!));
      out.submitted = true;
    } else {
      // the username first; the password field comes with the next step
      await plan.settle(() => submitFrom(f, f.user!));
      out.submitted = true;
      f = await waitFields(page, (x) => !!x.password || !!x.code, NEXT_STEP_MS);
      if (f.password) {
        origin = onSite();
        loginForm(f);
        await setInputValue(f.password, plan.password, { origin, password: true });
        out.filled.push('password');
        await plan.settle(() => submitFrom(f, f.password!));
      }
    }
    // a code page, if the site asks for one
    if (originMatches(login, here())) {
      const next = await waitFields(page, (x) => !!x.code || !x.password, 3_000);
      if (next.code && !next.password && originMatches(login, here())) await codeStep(next);
    }
  } else if (f.code) {
    await codeStep(f);
    out.submitted = out.filled.includes('code');
  }

  // the password must not stay in the page for a later read
  if (originMatches(login, here())) {
    await clearPasswordFields(page, plan.password, new URL(here()).origin);
    const last = await readFields(page).catch(() => undefined);
    out.stillAsking = !!last?.password;
  }
  out.url = here();
  return out;
}
