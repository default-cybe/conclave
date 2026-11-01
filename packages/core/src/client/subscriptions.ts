/**
 * Subscription sign-in (Settings > Models > Subscriptions, setup step 2). The
 * hub runs CLIProxyAPI (builtin) or uses one the owner already runs
 * (external), signs in to Claude, ChatGPT, Google, Grok, Kimi and Muse
 * through its management API, and lists every model those accounts give
 * under the provider id "cliproxy". Keys never leave the hub.
 * Only type declarations live here (see client/index.ts).
 */

export type SubscriptionsMode = 'off' | 'builtin' | 'external';

/**
 * off: nothing runs. installing: downloading CLIProxyAPI. starting: it is
 * starting, or the hub is reaching the external one. on: it answers.
 * error: it stopped or cannot be reached; `error` says why and what to do.
 */
export type SubscriptionsState = 'off' | 'installing' | 'starting' | 'on' | 'error';

/** One subscription the running CLIProxyAPI can sign in to. */
export interface SubscriptionProviderDto {
  /** CLIProxyAPI's provider id: claude, codex, antigravity, kimi, kimi-ai, xai, meta, devin, or a plugin's. */
  id: string;
  /** "Claude", "ChatGPT", "Google", "Grok", "Kimi", "Muse". */
  name: string;
  /** What signing in gives, in words ("Claude Pro or Max"). */
  plan: string;
  /** redirect: the provider sends the browser back to a localhost address. device: a code typed on the provider's page. */
  flow: 'redirect' | 'device';
  /** Accounts signed in for this provider. */
  accounts: number;
  /** Shown under "More" rather than with the main cards. */
  more?: boolean;
}

export type SubscriptionAccountState = 'active' | 'refreshing' | 'disabled' | 'unavailable' | 'error' | 'unknown';

/** A signed in account, from CLIProxyAPI's credentials list. Tokens are never included. */
export interface SubscriptionAccountDto {
  /** The credential's name in CLIProxyAPI; Remove and Refresh use it. */
  name: string;
  provider: string;
  providerName: string;
  /** The account's email or name when CLIProxyAPI knows it. */
  label?: string;
  state: SubscriptionAccountState;
  /** Why it is not active, in CLIProxyAPI's words. */
  detail?: string;
  /** Refresh asks the provider for a new token now. False when this CLIProxyAPI cannot. */
  canRefresh: boolean;
  updatedAt?: number;
}

/** Models from one account. account "" is the main set; "neu" is a second account whose ids start with neu/. */
export interface SubscriptionModelGroupDto {
  account: string;
  /** "Main accounts" or the prefix. */
  label: string;
  models: Array<{ id: string; ref: string; name: string; wire: 'anthropic' | 'openai'; ownedBy?: string }>;
}

export interface SubscriptionsStatus {
  mode: SubscriptionsMode;
  state: SubscriptionsState;
  /** When the state last changed. */
  since: number;
  /** What is happening now ("Downloading CLIProxyAPI, 12 of 22 MB"). */
  detail?: string;
  /** What went wrong and what to do next. */
  error?: string;
  /** The provider id the models appear under. */
  provider: 'cliproxy';
  /** The version that answers, from its X-CPA-VERSION header (or the program, while it starts). */
  version?: string;
  /** builtin: the program in use. managed: the hub downloaded it. verified: its SHA-256 matched the release's checksums file and the hub's pin. */
  binary?: { path: string; version?: string; managed: boolean; verified: boolean; sha256?: string };
  /** The version this hub build installs, and where it comes from. CLIProxyAPI is a separate MIT project. */
  pinned: { version: string; repo: string; license: 'MIT' };
  /** builtin with a managed program older than the pin: Update installs this version. */
  update?: { version: string };
  /** external: where it is. The keys stay on the hub; these say whether one is saved. */
  external?: { url: string; key: boolean; managementKey: boolean };
  /** Sign-in and the accounts list work: builtin, or external with a management key that answers. */
  management: boolean;
  /** Why sign-in is not available, when management is false and the mode is not off. */
  managementNote?: string;
  providers: SubscriptionProviderDto[];
  accounts: SubscriptionAccountDto[];
  models: SubscriptionModelGroupDto[];
  /** An existing providers.cliproxy entry that points at another computer: the external form starts from it. */
  suggested?: { url: string; key: boolean };
  /**
   * GET only: this request came from the hub's own computer, so the
   * provider's localhost redirect reaches the hub and no address needs
   * pasting. Events leave it out.
   */
  local?: boolean;
}

/** PUT /api/subscriptions. Fields left out keep their value. Keys go to the hub's secrets store. */
export interface SubscriptionsSettingsInput {
  mode?: SubscriptionsMode;
  /** external: the address, for example http://192.168.1.10:8317. */
  url?: string;
  /** external: a client key. Empty keeps the saved one. */
  key?: string;
  /** external: the management key. null forgets it. Empty keeps the saved one. */
  managementKey?: string | null;
}

/** POST /api/subscriptions/signin { provider }. */
export interface SignInStartDto {
  /** The login session; poll and paste with it. */
  state: string;
  provider: string;
  /** Open this in a new tab. */
  url: string;
  flow: 'redirect' | 'device';
  /** device: the code to type on the provider's page. */
  userCode?: string;
  /** When the login session ends. */
  expiresAt: number;
  /**
   * redirect: the hub is on this computer and catches the provider's
   * redirect to localhost, so the sign-in finishes by itself. When false
   * the page asks for the address from the browser bar instead.
   */
  caught: boolean;
  /** redirect: where the provider sends the browser at the end ("localhost:54545"). */
  callbackHost?: string;
}

export interface SignInStatusDto {
  state: string;
  /** wait: still signing in. ok: the account is saved. error: it failed (see error). cancelled: stopped from here. */
  status: 'wait' | 'ok' | 'error' | 'cancelled';
  error?: string;
  /** ok: the account that was added, when the hub can tell which. */
  account?: SubscriptionAccountDto;
}
