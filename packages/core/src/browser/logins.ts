/**
 * Saved logins (Settings > Browser, Sites and logins). The owner gives a
 * site's username and password once; browser_login fills them into that
 * site's login form itself, so the agent never sees the password.
 *
 * Where things live:
 * - <home>/browser-logins.json (mode 0600): the list, with no secret in it:
 *   id, profile, site, whether subdomains count, username, times, and
 *   whether a 2FA key is saved.
 * - The password and the 2FA key: hub secrets in secrets.json,
 *   `browser.login.<id>.password` and `browser.login.<id>.totp`, each
 *   encrypted with AES-256-GCM under a key of its own in
 *   <home>/browser-logins.key (mode 0600), the secret's name as associated
 *   data. Plain hub secrets are not encrypted; these are, by the owner's
 *   choice, so a copy of secrets.json alone (a backup with keys) holds no
 *   usable password.
 *
 * A member's logins (docs/design/ACCOUNTS.md 5) live in their own folder,
 * <home>/accounts/<id>/: browser-logins.json, their own browser-logins.key and
 * the sealed values in browser-logins.secrets.json, all mode 0600. The hub's
 * key and secrets.json are never used for them.
 *
 * Tools never read the list, the key or secrets.json (machine/private.ts).
 * Neither the list nor the key is in backups, and the backup leaves the
 * encrypted values out too: a restored hub asks for the passwords again.
 * A process running as the hub's user can still read the key and the
 * secrets together; this protects a copied file, not a hostile local user.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import type { ConfigStore } from '../config';
import { markHubPrivate } from '../machine/private';

/** One saved login as the hub keeps it. No secret in it. */
export interface SavedLogin {
  id: string;
  profile: string;
  /** https://www.facebook.com: scheme, host and port. */
  origin: string;
  /** Also fill on the site's subdomains (m.facebook.com for www.facebook.com). */
  subdomains: boolean;
  username: string;
  /** A 2FA key (TOTP) is saved. */
  totp: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsed?: number;
}

export interface LoginInput {
  profile?: string;
  site?: string;
  username?: string;
  /** Write only. Left out or empty keeps the saved one. */
  password?: string;
  /** Write only. null or empty removes it; left out keeps it. */
  totp?: string | null;
  subdomains?: boolean;
}

export const LOGINS_FILE = 'browser-logins.json';
export const LOGINS_KEY_FILE = 'browser-logins.key';
/** A member's sealed passwords and 2FA keys, in their own folder. */
export const LOGINS_SECRETS_FILE = 'browser-logins.secrets.json';
/** The secrets' names start with this; backups leave them out. */
export const LOGIN_SECRET_PREFIX = 'browser.login.';
const MAX_LOGINS = 200;
const SEALED = 'enc:v1:';
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = /^lg_[0-9a-f]{12}$/;

/** A login the hub cannot use: none saved, or saved with another hub's key. */
export class LoginUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginUnreadable';
  }
}

export function loginSecretName(id: string, field: 'password' | 'totp'): string {
  return `${LOGIN_SECRET_PREFIX}${id}.${field}`;
}

// ---------------------------------------------------------------------------
// Sites and the origin rule
// ---------------------------------------------------------------------------

/** "facebook.com", "https://www.facebook.com/login" -> https://www.facebook.com. Only http and https. */
export function siteOrigin(input: string): string {
  let s = (input ?? '').trim();
  if (!s) throw new Error('Site is empty. Use an address such as https://www.facebook.com.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) throw new Error(`"${input}" is not a web address. Use http or https.`);
    s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${input}" is not a web address.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`"${input}" is not a web address. Use http or https.`);
  if (!u.hostname) throw new Error(`"${input}" has no host.`);
  return u.origin;
}

/** The site's name for people: the host without www. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/**
 * True when a saved login may be filled on this page: the page's top-level
 * origin is the saved one exactly, or, with subdomains on, the same scheme
 * and port on the saved host (without www) or one of its subdomains. An
 * address by IP never counts for subdomains. Everything else is refused.
 */
export function originMatches(login: Pick<SavedLogin, 'origin' | 'subdomains'>, pageUrl: string): boolean {
  let page: URL;
  let saved: URL;
  try {
    page = new URL(pageUrl);
    saved = new URL(login.origin);
  } catch {
    return false;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  if (page.origin === saved.origin) return true;
  if (!login.subdomains || page.protocol !== saved.protocol || page.port !== saved.port) return false;
  const base = saved.hostname.replace(/^www\./, '');
  if (isIP(base) || isIP(page.hostname.replace(/^\[|\]$/g, '')) || !base.includes('.')) return false;
  return page.hostname === base || page.hostname.endsWith(`.${base}`);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------

export interface TotpSpec {
  key: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

function base32(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) throw new Error('The 2FA key is not a base32 key (letters A to Z and digits 2 to 7), or an otpauth:// link.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A 2FA key as the owner pastes it: the base32 key, or the otpauth:// link of its QR code. */
export function parseTotp(input: string): TotpSpec {
  const text = (input ?? '').trim();
  if (/^otpauth:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      throw new Error('The otpauth:// link is not valid.');
    }
    if (u.host.toLowerCase() !== 'totp') throw new Error('Only time based codes (otpauth://totp/...) are supported.');
    const secret = u.searchParams.get('secret');
    if (!secret) throw new Error('The otpauth:// link has no secret.');
    const digits = Number(u.searchParams.get('digits') ?? 6);
    const period = Number(u.searchParams.get('period') ?? 30);
    const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (![6, 7, 8].includes(digits)) throw new Error('The 2FA code must have 6 to 8 digits.');
    if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error('The 2FA period must be 10 to 300 seconds.');
    if (alg !== 'sha1' && alg !== 'sha256' && alg !== 'sha512') throw new Error('The 2FA algorithm must be SHA1, SHA256 or SHA512.');
    return { key: base32(secret), digits, period, algorithm: alg };
  }
  const key = base32(text);
  if (key.length < 10) throw new Error('The 2FA key is too short. Paste the whole key the site showed.');
  return { key, digits: 6, period: 30, algorithm: 'sha1' };
}

/** The code for now (RFC 6238, RFC 4226 truncation). */
export function totpCode(spec: TotpSpec, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / spec.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(spec.algorithm, spec.key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** spec.digits).padStart(spec.digits, '0');
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

function writePrivate(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw new Error(`${what} must be text.`);
  const t = v.trim();
  if (!t) throw new Error(`${what} is empty.`);
  if (t.length > max) throw new Error(`${what} is longer than ${max} characters.`);
  return t;
}

export class LoginVault {
  readonly file: string;
  readonly keyFile: string;
  /** A member's vault keeps its sealed values here instead of the hub's secrets. */
  readonly secretsFile?: string;
  /** A member's vault: every login is in their one browser, named this. */
  private readonly fixedProfile?: string;

  /** `dir` set: a member's own vault in that folder (<home>/accounts/<id>), with its own key and sealed values. */
  constructor(
    private readonly config: ConfigStore,
    opts: { dir?: string; profile?: string } = {},
  ) {
    const dir = opts.dir ?? config.paths.home;
    this.file = join(dir, LOGINS_FILE);
    this.keyFile = join(dir, LOGINS_KEY_FILE);
    if (opts.dir) {
      this.secretsFile = join(dir, LOGINS_SECRETS_FILE);
      this.fixedProfile = opts.profile ?? 'default';
      markHubPrivate(this.secretsFile);
    }
    // tools never read the list or the key (the secrets file is marked by the engine)
    markHubPrivate(this.file);
    markHubPrivate(this.keyFile);
  }

  private secretGet(name: string): string | undefined {
    if (!this.secretsFile) return this.config.secretValue(name);
    return this.readSecrets()[name];
  }

  private secretSet(name: string, value: string | undefined): void {
    if (!this.secretsFile) return void this.config.setSecret('values', name, value);
    const all = this.readSecrets();
    if (value === undefined) {
      if (!(name in all)) return;
      delete all[name];
    } else all[name] = value;
    writePrivate(this.secretsFile, JSON.stringify(all, null, 2) + '\n');
  }

  private readSecrets(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.secretsFile!, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private read(): SavedLogin[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (x): x is SavedLogin => !!x && typeof x.id === 'string' && ID.test(x.id) && typeof x.profile === 'string' && typeof x.origin === 'string' && typeof x.username === 'string',
      );
    } catch {
      return [];
    }
  }

  private write(list: SavedLogin[]): void {
    writePrivate(this.file, JSON.stringify(list, null, 2) + '\n');
  }

  /** The saved logins, newest use first; one profile's with a name. */
  list(profile?: string): SavedLogin[] {
    const all = this.read().map((l) => ({ ...l, subdomains: !!l.subdomains, totp: !!l.totp }));
    return (profile ? all.filter((l) => l.profile === profile) : all).sort((a, b) => (b.lastUsed ?? b.updatedAt) - (a.lastUsed ?? a.updatedAt));
  }

  get(id: string): SavedLogin | undefined {
    return this.list().find((l) => l.id === id);
  }

  /** Save a new login. The password and 2FA key go to the hub's secrets, encrypted. */
  add(input: LoginInput): SavedLogin {
    const list = this.read();
    if (list.length >= MAX_LOGINS) throw new Error(`At most ${MAX_LOGINS} logins can be saved.`);
    const profile = this.profileName(input.profile ?? 'default');
    const origin = siteOrigin(input.site ?? '');
    const username = text(input.username, 'Username', 256);
    const password = this.password(input.password);
    if (!password) throw new Error('Password is empty.');
    const totp = input.totp ? this.totpText(input.totp) : undefined;
    const same = list.find((l) => l.profile === profile && l.origin === origin && l.username.toLowerCase() === username.toLowerCase());
    if (same) throw new Error(`Profile ${profile} already has a login for ${siteHost(origin)} as ${username}. Edit that one.`);
    const now = Date.now();
    const login: SavedLogin = { id: `lg_${randomBytes(6).toString('hex')}`, profile, origin, subdomains: !!input.subdomains, username, totp: !!totp, createdAt: now, updatedAt: now };
    this.seal(login.id, 'password', password);
    if (totp) this.seal(login.id, 'totp', totp);
    this.write([...list, login]);
    return login;
  }

  /** Change a login. A password or 2FA key given replaces the saved one; null removes the 2FA key. */
  update(id: string, input: LoginInput): SavedLogin {
    const list = this.read();
    const i = list.findIndex((l) => l.id === id);
    if (i < 0) throw new Error('That saved login is gone.');
    const cur = list[i];
    const next: SavedLogin = { ...cur, updatedAt: Date.now() };
    if (input.profile !== undefined) next.profile = this.profileName(input.profile);
    if (input.site !== undefined) next.origin = siteOrigin(input.site);
    if (input.username !== undefined) next.username = text(input.username, 'Username', 256);
    if (input.subdomains !== undefined) next.subdomains = !!input.subdomains;
    const password = this.password(input.password);
    const dropTotp = input.totp === null || input.totp === '';
    const totp = !dropTotp && input.totp !== undefined ? this.totpText(input.totp) : undefined;
    const clash = list.find((l, j) => j !== i && l.profile === next.profile && l.origin === next.origin && l.username.toLowerCase() === next.username.toLowerCase());
    if (clash) throw new Error(`Profile ${next.profile} already has a login for ${siteHost(next.origin)} as ${next.username}.`);
    // a site or profile change keeps the password: the owner moved the login, nothing reads it
    if (password) this.seal(id, 'password', password);
    if (dropTotp) {
      this.secretSet(loginSecretName(id, 'totp'), undefined);
      next.totp = false;
    } else if (totp) {
      this.seal(id, 'totp', totp);
      next.totp = true;
    }
    list[i] = next;
    this.write(list);
    return next;
  }

  /** Delete a login and its secrets. */
  remove(id: string): boolean {
    const list = this.read();
    const left = list.filter((l) => l.id !== id);
    this.secretSet(loginSecretName(id, 'password'), undefined);
    this.secretSet(loginSecretName(id, 'totp'), undefined);
    if (left.length === list.length) return false;
    this.write(left);
    return true;
  }

  /** Delete every login of a profile. */
  removeProfile(profile: string): number {
    const gone = this.read().filter((l) => l.profile === profile);
    for (const l of gone) this.remove(l.id);
    return gone.length;
  }

  touch(id: string): void {
    const list = this.read();
    const l = list.find((x) => x.id === id);
    if (!l) return;
    l.lastUsed = Date.now();
    this.write(list);
  }

  /** The password or 2FA key, for the hub's own fill. Never for a reply, a log or an audit line. */
  secret(id: string, field: 'password' | 'totp'): string {
    const sealed = this.secretGet(loginSecretName(id, field));
    if (!sealed) throw new LoginUnreadable(field === 'password' ? 'No password is saved for this login. Save it again in Settings, Browser.' : 'No 2FA key is saved for this login.');
    const key = this.key(false);
    const plain = key ? open(key, loginSecretName(id, field), sealed) : undefined;
    if (plain === undefined) throw new LoginUnreadable('This login was saved with another key (a restored backup, or the key file was replaced). Save the password again in Settings, Browser.');
    return plain;
  }

  /** True when the hub can read the login's password. */
  readable(id: string): boolean {
    try {
      this.secret(id, 'password');
      return true;
    } catch {
      return false;
    }
  }

  private profileName(raw: string): string {
    if (this.fixedProfile) return this.fixedProfile;
    const n = (raw ?? '').trim() || 'default';
    if (!PROFILE.test(n) || n.includes('..')) throw new Error(`Invalid profile name "${raw}". Use letters, digits, dot, dash or underscore (max 64).`);
    return n;
  }

  private password(v: unknown): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error('Password must be text.');
    if (v.length > 1024) throw new Error('Password is longer than 1024 characters.');
    // kept as typed: spaces can be part of a password
    return v;
  }

  private totpText(v: unknown): string {
    if (typeof v !== 'string') throw new Error('The 2FA key must be text.');
    const t = v.trim();
    if (t.length > 1024) throw new Error('The 2FA key is too long.');
    parseTotp(t);
    return t;
  }

  private seal(id: string, field: 'password' | 'totp', plain: string): void {
    const name = loginSecretName(id, field);
    this.secretSet(name, seal(this.key(true)!, name, plain));
  }

  private key(create: boolean): Buffer | undefined {
    return sealKey(this.keyFile, create);
  }
}

/**
 * The hub's sealing key (browser-logins.key), made on first use. A damaged key
 * file stops a save rather than being replaced. Also seals MCP OAuth tokens
 * (extensions/mcp-oauth.ts).
 */
export function sealKey(keyFile: string, create: boolean): Buffer | undefined {
  if (existsSync(keyFile)) {
    const k = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (k.length !== 32) {
      if (create) throw new Error(`${keyFile} is damaged. Delete it, then save the logins again.`);
      return undefined;
    }
    return k;
  }
  if (!create) return undefined;
  const k = randomBytes(32);
  writePrivate(keyFile, k.toString('base64') + '\n');
  return k;
}

/** AES-256-GCM with the secret's name as associated data. */
export function seal(key: Buffer, name: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function open(key: Buffer, name: string, sealed: string): string | undefined {
  if (!sealed.startsWith(SEALED)) return undefined;
  const parts = sealed.slice(SEALED.length).split('.');
  if (parts.length !== 3) return undefined;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(name, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
