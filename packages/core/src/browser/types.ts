/**
 * What Settings > Browser gets from the hub about engines, the install, the
 * system libraries and proxies (routes-browser.ts). Types only. Nothing here
 * carries a password, a pasted list or an expanded list URL.
 */
import type { HubPlaceDto, RootHelperDto } from '../system/root-helper';
import type { BrowserSetupOffer, BrowserSetupTarget } from './setup-plan';

export type { BrowserSetupOffer, BrowserSetupStep, BrowserSetupTarget } from './setup-plan';
export type { HubPlaceDto, RootHelperDto } from '../system/root-helper';

export interface BrowserEngineDto {
  engine: 'chromium' | 'cloak';
  label: string;
  installed: boolean;
  version?: string;
  path?: string;
  /** hub: in the hub's browser folder; config: a path set by hand; playwright: Playwright's own folder; system: a Chrome on the machine. */
  where?: 'hub' | 'config' | 'playwright' | 'system';
  /** What Install on the hub would run for it, or why nothing runs. */
  setup: BrowserSetupOffer;
}

/**
 * System libraries the installed browsers cannot find, the one command for
 * root that adds them, and whether the hub can add them itself through the
 * root helper.
 */
export interface BrowserLibsDto {
  missing: string[];
  /** The machine has no fonts: Chromium draws no text. */
  noFonts: boolean;
  packages: string[];
  /** apt-get install ..., to run as root. */
  command?: string;
  /** The hub runs in the Docker image: the fix is a rebuild with --build-arg BROWSER=1. */
  docker?: boolean;
  /** Where the hub runs, so the page says where to run a command. */
  place?: HubPlaceDto;
  /** The root helper (conclave system-helper install), and the command that installs it. */
  helper?: RootHelperDto;
  /** Set when the helper can do it: what Install system libraries runs, exactly as shown and confirmed. */
  setup?: { say: string; lines: string[] };
}

/** POST /api/browser/libs: what ran, how it ended, and the libraries after it. */
export interface BrowserLibsResult {
  ok: boolean;
  ran: string[];
  tail: string;
  durationMs: number;
  failed?: string;
  /** Every library is there now. */
  ready: boolean;
  /** What is still missing, if anything. */
  libs?: BrowserLibsDto;
}

/** The hub's proxy as Settings > Browser shows it. Says whether a login or password is saved, never what it is. */
export interface BrowserProxySettingsDto {
  provider: 'none' | 'dataimpulse' | 'custom';
  dataimpulse: { host: string; port: number; login: boolean; password: boolean; country?: string };
  custom: { url?: string; password: boolean };
  /** What is wrong with the saved settings, if anything. */
  problem?: string;
}

/** POST /api/browser/setup: what ran and how it ended. */
export interface BrowserSetupResult {
  ok: boolean;
  target: BrowserSetupTarget;
  /** The step lines that ran, in order. */
  ran: string[];
  /** The last lines of output. */
  tail: string;
  durationMs: number;
  /** The step that failed. */
  failed?: string;
}

/** POST /api/browser/proxy/test */
export interface BrowserProxyTestDto {
  ok: boolean;
  /** The proxy's label ("DataImpulse, Japan"): never a login or password. */
  proxy: string;
  ip?: string;
  country?: string;
  ms: number;
  error?: string;
}

/** PUT /api/browser/profiles/:name */
export interface BrowserProfileUpdate {
  engine?: 'chromium' | 'cloak';
}

/**
 * PUT /api/browser/proxy. A login or password given here goes to the hub's
 * secrets; null removes it; left out keeps it.
 */
export interface BrowserProxyUpdate {
  provider: 'none' | 'dataimpulse' | 'custom';
  dataimpulse?: { host?: string | null; port?: number | null; login?: string | null; password?: string | null; country?: string | null };
  custom?: { url?: string | null; password?: string | null };
}

/**
 * A saved login as Settings > Browser shows it (GET /api/browser, on each
 * profile). Says whether a password and a 2FA key are saved, never what
 * they are.
 */
export interface BrowserLoginDto {
  id: string;
  profile: string;
  /** https://www.facebook.com */
  origin: string;
  /** facebook.com: the host without www. */
  host: string;
  username: string;
  /** Also filled on the site's subdomains. */
  subdomains: boolean;
  /** The hub can read the saved password. */
  password: boolean;
  /** A 2FA key is saved. */
  totp: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsed?: number;
  /** Why the hub cannot use it, if it cannot. */
  problem?: string;
}

/**
 * POST /api/browser/logins and PUT /api/browser/logins/:id. The password and
 * the 2FA key are write only: they go to the hub's secrets, encrypted, and
 * never come back. Left out keeps them; a 2FA key of null removes it.
 */
export interface BrowserLoginInput {
  profile?: string;
  site?: string;
  username?: string;
  password?: string;
  totp?: string | null;
  subdomains?: boolean;
}

/** A watch or routine that uses a profile, for the confirm before Delete profile. */
export interface BrowserProfileUserDto {
  id: string;
  name: string;
  watch: boolean;
}
