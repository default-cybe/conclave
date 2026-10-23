/**
 * Watches (docs/ASSISTANT.md, DESIGN.md 34): a routine with a memory of the
 * items it saw. Each run reports what it found with WatchReport; the hub
 * keeps the items, compares them with the run before, keeps each item's
 * history and tells the owner what changed. Types only, shared with the
 * clients through core/src/client/watches.ts.
 */
import type { BrowserEngineDto, BrowserLibsDto, BrowserLoginDto, BrowserProfileUserDto, BrowserProxySettingsDto } from '../browser/types';

/** Filters the run reads with and the hub checks new items against. */
export interface WatchFilters {
  minPrice?: number;
  maxPrice?: number;
  /** Most distance from `near`, in `unit`. Checked only for items that report a distance. */
  maxDistance?: number;
  unit?: 'km' | 'mi';
  /** Where the distance is measured from: "Oakland, CA". */
  near?: string;
  /** What to search for. The run uses them; the hub does not check titles against them. */
  keywords?: string[];
  /** Items whose title has one of these words are left out ("salvage", "parts"). */
  exclude?: string[];
}

/** What makes a routine a watch: Routine.watch. */
export interface WatchSpec {
  /** The page a run starts at, usually a search address with the filters in it. */
  url: string;
  /** Browser profile the runs use, the one the owner signed in to the site with. Default "default". */
  profile?: string;
  /** Fields to read for each item besides the standard ones: "year", "mileage". */
  fields?: string[];
  filters?: WatchFilters;
  /** change (default): a message only when something changed. daily: a summary after every run. */
  notify?: 'change' | 'daily';
  /** Most items kept. Default 200, at most 1000. Gone items go first. */
  cap?: number;
  /** Currency of the prices, for words: "USD", "EUR". */
  currency?: string;
}

/** The site's own word for a listing. sold and gone both end the item. */
export type ListingStatus = 'available' | 'pending' | 'sold' | 'gone';

/** One item as a run reports it (WatchReport). */
export interface ReportedItem {
  id: string;
  title: string;
  price?: number;
  /** The price as the site shows it, when it is not a plain number ("Free", "$6,500 obo"). */
  priceText?: string;
  location?: string;
  /** Distance from `filters.near`, in the filter's unit. */
  distance?: number;
  url?: string;
  image?: string;
  status?: ListingStatus;
  fields?: Record<string, string>;
}

/** How an item stands after the last run. */
export type WatchMark = 'new' | 'still' | 'gone' | 'price_down' | 'price_up' | 'changed';

export interface WatchHistoryEntry {
  at: number;
  kind: 'seen' | 'price' | 'status' | 'gone' | 'back';
  /** price: the new price, and the old one in `from`. */
  price?: number;
  from?: number;
  /** status: the new listing status. gone: why ("sold", "not found", "removed"). */
  status?: string;
}

/** One item the hub keeps for a watch. */
export interface WatchItem {
  id: string;
  title: string;
  price?: number;
  priceText?: string;
  location?: string;
  distance?: number;
  url?: string;
  image?: string;
  status: ListingStatus;
  fields?: Record<string, string>;
  /** Still listed as of the last run. */
  present: boolean;
  mark: WatchMark;
  firstSeen: number;
  lastSeen: number;
  goneAt?: number;
  /** Oldest first, at most HISTORY_MAX entries. */
  history: WatchHistoryEntry[];
}

export interface WatchCounts {
  new: number;
  gone: number;
  priceDown: number;
  priceUp: number;
  changed: number;
  still: number;
}

/** What one run changed. */
export interface WatchRunSummary {
  runId: string;
  routineId: string;
  at: number;
  counts: WatchCounts;
  /** Items listed after the run. */
  total: number;
  /** Ids per change, for the cards. */
  changes: { new: string[]; gone: string[]; priceDown: string[]; priceUp: string[]; changed: string[] };
  /** Items the run reported that the filters left out. */
  filtered?: number;
  /** "3 new, 1 gone, 1 price drop", or "No change". */
  words: string;
}

/** One row of the Routines page: GET /api/watches. */
export interface WatchSummaryDto {
  routineId: string;
  /** Items listed now. */
  count: number;
  /** New in the last run. */
  newCount: number;
  last?: WatchRunSummary;
  /** An item with a photo, newest first, for the row's picture. */
  cover?: { itemId: string; title: string };
}

/** A watch page: GET /api/watches/:id. */
export interface WatchDetailDto extends WatchSummaryDto {
  spec: WatchSpec;
  /** Listed first (new, price changes, the rest), gone last. */
  items: WatchItem[];
  /** Newest first. */
  runs: WatchRunSummary[];
}

/** The card a WatchReport result carries in a chat (meta.watch). */
export interface WatchItemsCard {
  kind: 'items';
  /** The page the items came from. */
  source?: string;
  currency?: string;
  items: Array<Pick<WatchItem, 'id' | 'title' | 'price' | 'priceText' | 'location' | 'url' | 'image' | 'status' | 'fields'> & { mark?: WatchMark; was?: number }>;
  /** Set in a watch run: the routine and how many are listed. */
  routineId?: string;
  /** In a chat: the hub keeps these as the start of a watch made from this chat. */
  offer?: boolean;
}

/** The card WatchCreate leaves in the chat. */
export interface WatchCreatedCard {
  kind: 'created';
  routineId: string;
  name: string;
  schedule: string;
  nextRunAt?: number;
  count: number;
}

export type WatchCardData = WatchItemsCard | WatchCreatedCard;

/** What a watch notice carries for the in-app card (Notice.watch). */
export interface WatchNotice {
  routineId: string;
  runId: string;
  counts: WatchCounts;
  items: Array<{ id: string; title: string; price?: number; priceText?: string; was?: number; mark: WatchMark; url?: string; image?: boolean }>;
  currency?: string;
}

/** A browser profile and the sites the owner signed in to with it (Settings > Browser). */
export interface BrowserProfileDto {
  name: string;
  engine: string;
  label: string;
  open: boolean;
  sites: Array<{ host: string; at: number }>;
  /** The profile has a folder: it has run, and a new engine would be a new identity. */
  folder?: boolean;
  /** Its engine is set in the config (a profile without one is new, or an old Chromium one). */
  engineSet?: boolean;
  /** The logins saved for this profile (Settings > Browser, Sites and logins). */
  logins?: BrowserLoginDto[];
  /** The profile sessions use when they pick none. It cannot be deleted. */
  isDefault?: boolean;
  /** Watches and routines that use it, for the confirm before Delete profile. */
  usedBy?: BrowserProfileUserDto[];
}

export interface BrowserStatusDto {
  available: boolean;
  reason?: string;
  profiles: BrowserProfileDto[];
  /** playwright-core, which drives both engines. */
  playwright?: { installed: boolean; version?: string; where?: 'app' | 'hub' };
  engines?: BrowserEngineDto[];
  libs?: BrowserLibsDto;
  /** The hub's proxy: once per blocked request, or when the owner asks for it in a chat. */
  proxy?: BrowserProxySettingsDto;
  /** The engine a new profile gets. */
  newProfileEngine?: 'chromium' | 'cloak';
  /** The hub's browser folder. */
  dir?: string;
}

/** A remote view of a profile's page for signing in (POST /api/browser/signin). */
export interface SignInViewDto {
  id: string;
  profile: string;
  url: string;
}

/** The latest frame of a sign-in view. */
export interface SignInFrameDto {
  seq: number;
  url: string;
  width: number;
  height: number;
  /** JPEG, base64. */
  data: string;
}
