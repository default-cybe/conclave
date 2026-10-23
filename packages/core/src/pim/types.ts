/**
 * Calendar and mail accounts, and the proposals the owner approves
 * (docs/DESIGN.md, Calendar and mail). Plain types for the hub, the web app,
 * its mock and the Android client. No secrets: passwords and refresh tokens
 * stay in the hub's secret store.
 */
import type { CaldavPresetInfo, CalendarInfo, EventAttendee } from '../calendar/types';
import type { MailPresetInfo, MailSecurity } from '../mail/types';

export type PimAccountKind = 'caldav' | 'imap' | 'google' | 'microsoft';

/**
 * Which OAuth client signed an account in, so refresh uses the same one. web
 * is the hub's own Web application client; relay is the project's shared Web
 * client, whose redirect is the relay page on the project site.
 */
export type OAuthClientKind = 'web' | 'relay' | 'desktop' | 'ios' | 'android' | 'microsoft';

/** A calendar on an account and what the assistant may do with it. */
export interface CalendarPick {
  /** The provider's id: the collection URL for CalDAV, the calendar id for Google. */
  remoteId: string;
  name: string;
  color?: string;
  writable: boolean;
  read: boolean;
  write: boolean;
}

/** An account as stored and as Settings shows it. */
export interface PimAccount {
  id: string;
  kind: PimAccountKind;
  label: string;
  createdAt: number;
  updatedAt: number;
  /** CalDAV */
  serverUrl?: string;
  username?: string;
  preset?: string;
  /** CalDAV: the server sends invitations itself. */
  scheduling?: boolean;
  /** CalDAV: the account's own address, ORGANIZER of invitations. */
  organizer?: string;
  outbox?: string;
  /** IMAP */
  imap?: { host: string; port: number; security: MailSecurity };
  smtp?: { host: string; port: number; security: MailSecurity };
  /** The From address of drafts. */
  address?: string;
  draftsFolder?: string;
  /** OAuth */
  email?: string;
  client?: OAuthClientKind;
  clientId?: string;
  /** Scopes the provider granted. */
  scopes?: string[];
  /** What the account is used for. */
  mail?: boolean;
  calendar?: boolean;
  /** The assistant may save drafts (needs gmail.compose or Mail.ReadWrite on OAuth accounts). */
  drafts?: boolean;
  /** The owner opted in to sending approved messages, not only saving drafts. */
  send?: boolean;
  calendars?: CalendarPick[];
  lastCheck?: { at: number; ok: boolean; detail: string };
}

export interface PimAccountDto extends PimAccount {
  /** A password or refresh token is stored for it. */
  signedIn: boolean;
}

export type ProposalStatus = 'pending' | 'applied' | 'declined' | 'failed';

export interface EventProposalBody {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  calendarId: string;
  calendar: string;
  account: string;
  location?: string;
  description?: string;
  attendees?: string[];
  project?: string;
  /** What happens to invitations: the server sends them, or nobody does. */
  invites?: 'server' | 'none';
}

export interface MailProposalBody {
  accountId: string;
  account: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** The subject of the message this answers. */
  inReplyTo?: string;
}

/** A write the owner approves on a card: an event to create, move or delete, or a message to save as a draft or send. */
export interface ProposalDto {
  id: string;
  kind: 'event' | 'mail';
  action: 'create' | 'update' | 'delete' | 'draft' | 'send';
  status: ProposalStatus;
  /** One line for lists and notifications. */
  summary: string;
  createdAt: number;
  decidedAt?: number;
  sessionId?: string;
  event?: EventProposalBody;
  /** For a change or a delete: the event as it is now. */
  before?: { title: string; start: number; end: number; allDay: boolean };
  mail?: MailProposalBody;
  /** What the hub did after approval, or why it failed. */
  result?: string;
  error?: string;
}

/** Today's events on Home, in the owner's zone. */
export interface TodayEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  calendar: string;
  color?: string;
  location?: string;
}

export interface GoogleOAuthStatus {
  /** Shipped client ids that are filled in (oauth-clients.ts); web is the shared Web client behind the relay. */
  builtin: { desktop: boolean; web: boolean; ios: boolean; android: boolean };
  /** This hub's own clients (Settings overrides). */
  hub: { webClientId?: string; webSecret: boolean; desktopClientId?: string; desktopSecret: boolean };
  /** Redirect URIs to register: the hub's https callback when it has an https address, and the loopback one. */
  redirect: { web?: string; loopback: string };
  /**
   * The relay page Google sends the browser to, when the shared Web client is
   * set: it hands the sign-in back to this hub after the owner presses
   * Continue. Missing: no relay.
   */
  relay?: string;
  /** How sign-in works on this hub, one sentence for Settings. */
  how: string;
  /** Sign in works without setup steps. */
  ready: boolean;
}

export interface MicrosoftOAuthStatus {
  builtin: boolean;
  hubClientId?: string;
  ready: boolean;
}

export interface PimSettingsDto {
  accounts: PimAccountDto[];
  calendars: CalendarInfo[];
  timezone: string;
  oauth: { google: GoogleOAuthStatus; microsoft: MicrosoftOAuthStatus };
  presets: { caldav: CaldavPresetInfo[]; mail: MailPresetInfo[] };
  pending: number;
}

/** A sign-in in progress. */
export interface OAuthFlowDto {
  id: string;
  provider: 'google' | 'microsoft';
  state: 'waiting' | 'done' | 'failed';
  /** Google: open this in a browser. */
  url?: string;
  /** Microsoft: the code to type at verificationUri. */
  userCode?: string;
  verificationUri?: string;
  expiresAt: number;
  error?: string;
  accountId?: string;
}

export type { EventAttendee };
