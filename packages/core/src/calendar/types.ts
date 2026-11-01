/**
 * Calendars in the hub (docs/DESIGN.md, Calendar and mail): CalDAV accounts
 * (Nextcloud, iCloud, Fastmail, any server) and Google Calendar through a
 * Google sign-in. Plain types, no node imports, so the web app and its mock
 * use them too.
 */

/** A calendar the hub found on an account, and what the assistant may do with it. */
export interface CalendarInfo {
  /** Short id the tools use: "cal_" and 8 hex characters, stable per account and calendar. */
  id: string;
  accountId: string;
  /** The account's label ("Nextcloud", "me@icloud.com"). */
  account: string;
  name: string;
  color?: string;
  /** The server lets this account write to it. */
  writable: boolean;
  /** The owner lets the assistant read it. */
  read: boolean;
  /** The owner lets the assistant propose events in it. */
  write: boolean;
  /** The server sends invitations to attendees (CalDAV scheduling, or Google). */
  scheduling?: boolean;
}

export interface EventAttendee {
  email: string;
  name?: string;
  /** accepted, declined, tentative, needs-action. */
  status?: string;
}

/** One occurrence of an event, in the owner's zone. */
export interface CalEvent {
  /** Short id the tools use for update and delete ("ev_" and 10 hex characters). */
  id: string;
  calendarId: string;
  calendar: string;
  title: string;
  /** Epoch ms. */
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: EventAttendee[];
  organizer?: string;
  /** Part of a repeating series. */
  recurring: boolean;
  /** Blocks time: not marked free, not cancelled. All-day events count only when marked busy. */
  busy: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  /** Time booking: the project this block is for (CATEGORIES or the Google extended property). */
  project?: string;
}

/** What a create or update proposes. Times are local "YYYY-MM-DDTHH:MM" in the owner's zone, or a date for all-day events. */
export interface EventDraft {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  project?: string;
}

export interface BusyBlock {
  start: number;
  end: number;
  /** Whose time: "you" or an attendee's email. */
  who: string;
}

export interface FreeSlot {
  start: number;
  end: number;
  minutes: number;
}

export type CaldavPreset = 'nextcloud' | 'icloud' | 'fastmail' | 'other';

export interface CaldavPresetInfo {
  id: CaldavPreset;
  label: string;
  /** The server address, or a template with <host> the owner fills in. */
  url: string;
  /** What to put in the username field. */
  username: string;
  /** Where the app password comes from, one line. */
  password: string;
}

/** CalDAV presets. Google is not one: Google Calendar needs OAuth, so it comes with Sign in with Google. */
export const CALDAV_PRESETS: CaldavPresetInfo[] = [
  { id: 'nextcloud', label: 'Nextcloud', url: 'https://<host>/remote.php/dav', username: 'Your Nextcloud user name', password: 'Settings > Security > Devices and sessions > Create new app password.' },
  { id: 'icloud', label: 'iCloud', url: 'https://caldav.icloud.com', username: 'Your Apple Account email', password: 'account.apple.com > Sign-In and Security > App-Specific Passwords.' },
  { id: 'fastmail', label: 'Fastmail', url: 'https://caldav.fastmail.com/dav/', username: 'Your full Fastmail address', password: 'Settings > Privacy and security > Manage app passwords, access Calendars (CalDAV).' },
  { id: 'other', label: 'Other CalDAV server', url: 'https://', username: 'The user name the server knows you by', password: 'An app password if the server has them, else your password.' },
];
