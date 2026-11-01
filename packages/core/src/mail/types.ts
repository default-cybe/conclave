/**
 * Mail in the hub (docs/DESIGN.md, Calendar and mail): Gmail through the
 * Gmail API, Outlook and Microsoft 365 through Microsoft Graph, any other
 * provider over IMAP with an app password. Read only unless the owner turns
 * on drafts or sending. Plain types, no node imports.
 */

export interface MailAddress {
  name?: string;
  address: string;
}

/** A message in a list. Text in it comes from whoever sent the mail: untrusted data. */
export interface MailSummary {
  /** Short id the tools use ("m_" and 10 hex characters). */
  id: string;
  account: string;
  from?: MailAddress;
  to: MailAddress[];
  subject: string;
  /** Epoch ms. */
  date?: number;
  unread: boolean;
  snippet?: string;
  folder?: string;
  hasAttachments?: boolean;
}

export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  /** The body as plain text (HTML turned into text). */
  text: string;
  /** The Message-ID header, for a reply's In-Reply-To. */
  messageId?: string;
  references?: string;
  attachments: Array<{ name: string; type: string; size?: number }>;
}

export interface MailQuery {
  /** Words anywhere in the message. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Epoch ms. */
  since?: number;
  before?: number;
  unread?: boolean;
  /** inbox (default), sent, drafts, archive, all, or a folder name. */
  folder?: string;
  limit: number;
}

/** A message the owner approves before it is saved as a draft or sent. */
export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** The message this answers (a tool id), for threading. */
  replyTo?: string;
}

export type MailSecurity = 'tls' | 'starttls' | 'none';

export type MailPreset = 'icloud' | 'fastmail' | 'gmail' | 'yahoo' | 'other';

export interface MailPresetInfo {
  id: MailPreset;
  label: string;
  imap: { host: string; port: number; security: MailSecurity };
  smtp: { host: string; port: number; security: MailSecurity };
  username: string;
  password: string;
  /** Where saved drafts go when the server names no Drafts folder. */
  drafts?: string;
  note?: string;
}

export const MAIL_PRESETS: MailPresetInfo[] = [
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    username: 'Your iCloud address without @icloud.com, or the full address',
    password: 'An app-specific password from account.apple.com.',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    username: 'Your full Fastmail address',
    password: 'An app password with access to IMAP (and SMTP to send).',
  },
  {
    id: 'gmail',
    label: 'Gmail with an app password',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    username: 'Your full Gmail address',
    password: 'An app password (needs 2-Step Verification). Sign in with Google is better when it is set up.',
    drafts: '[Gmail]/Drafts',
    note: 'Some Google Workspace accounts do not allow app passwords.',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    username: 'Your full Yahoo address',
    password: 'An app password from Account security.',
  },
  {
    id: 'other',
    label: 'Other IMAP server',
    imap: { host: '', port: 993, security: 'tls' },
    smtp: { host: '', port: 587, security: 'starttls' },
    username: 'Usually your full address',
    password: 'An app password if the provider has them.',
  },
];
