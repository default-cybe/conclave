/** Accounts: several people on one hub (docs/design/ACCOUNTS.md). */
export { OWNER_ID, runAs, runAsHub, currentAccount, isMember } from './context';
export { PeopleStore, PeopleError, purgeAccount, accountKey, NAME_RE, type HubAccount, type AccountRole, type AccountSettings, type ProviderGrants } from './store';
export { migratePeople } from './migrate';
export { ACCOUNT_TABLES, CHILD_TABLES, HUB_TABLES, ensureAccountColumn, ensureColumn } from './tables';
export { AccountSecrets } from './secrets';
export { ProviderAccess, AccessError, monthWindow, type KeySource, type ProviderAccessInfo } from './access';
export { guardMachine, mayUse, MachineRefused, HUB_REFUSED, DEVICE_REFUSED, CODE_NEEDS_DEVICE } from './guard';
export { eventAccount, eventVisibleTo, HUB_WIDE_EVENTS, type AccountLookup } from './events';
