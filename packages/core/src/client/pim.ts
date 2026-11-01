/** DTOs of the calendar and mail routes (docs/DESIGN.md, Calendar and mail). Types only. */
export type {
  CalendarPick,
  EventProposalBody,
  GoogleOAuthStatus,
  MailProposalBody,
  MicrosoftOAuthStatus,
  OAuthClientKind,
  OAuthFlowDto,
  PimAccount,
  PimAccountDto,
  PimAccountKind,
  PimSettingsDto,
  ProposalDto,
  ProposalStatus,
  TodayEvent,
} from '../pim/types';
export type { CalendarInfo, CaldavPreset, CaldavPresetInfo, EventDraft } from '../calendar/types';
export type { MailPreset, MailPresetInfo, MailSecurity } from '../mail/types';

/** What a sign-in asks the provider for. */
export interface PimWants {
  mail?: boolean;
  drafts?: boolean;
  send?: boolean;
  calendar?: boolean;
  calendarWrite?: boolean;
}
