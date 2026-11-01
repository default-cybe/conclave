/**
 * Watch tools (watches/service.ts). WatchReport hands the hub the items a
 * browser search found: in a chat the owner sees them as cards and they
 * become the start of a watch made from the chat; in a watch run the hub
 * keeps them and compares them with the last run when the run ends.
 * WatchCreate makes the watch: a routine that runs the search on a
 * schedule, reading only, and tells the owner what changed.
 */
import { WatchError, type WatchCreateInput } from '../watches/service';
import type { WatchCardData } from '../watches/types';
import type { Tool, ToolOutput } from './types';
import { fail } from './util';

const NO_WATCHES = 'Watches are not available on this hub.';

export interface WatchReportInput {
  items: unknown[];
  source?: string;
}

export const WatchReportTool: Tool<WatchReportInput> = {
  name: 'WatchReport',
  description: `Report the listings a browser search found (cars, flats, tickets). Use it whenever you show search results from a site, and in every watch run.

In a chat the owner sees them as cards with photos, prices and links, so do not list them again; a watch made from the chat starts from them. In a watch run the hub compares them with the last run when the run ends, and the reply lists the last run's items you have not reported yet.

items, one per listing:
- id: the site's id, usually from its link (".../item/123456/" is "123456"). The same every time.
- title, price (a number or the site's text, "$6,500"), location, url (its own link), image (its photo address).
- status: available (default), pending, sold, or gone when its page says it is no longer listed.
- fields: other facts the watch reads, such as {"year": "2014", "mileage": "98,000 mi"}.
- distance: from the search's place, when the site shows it.
source: the page they came from.`,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            price: { type: ['number', 'string'] },
            location: { type: 'string' },
            url: { type: 'string' },
            image: { type: 'string' },
            status: { type: 'string', enum: ['available', 'pending', 'sold', 'gone'] },
            distance: { type: 'number' },
            fields: { type: 'object' },
          },
        },
      },
      source: { type: 'string' },
    },
    required: ['items'],
    additionalProperties: false,
  },
  // it only tells the hub what the page said; nothing outside the hub changes
  readOnly: true,
  // only agents that browse get it (the assistant's optInTools); a watch run always does (watches/index.ts)
  optIn: true,
  summarize: (i) => `Report ${Array.isArray(i.items) ? i.items.length : 0} items`,
  async run(input, ctx) {
    const svc = ctx.host.watches;
    if (!svc) return fail(NO_WATCHES);
    if (!Array.isArray(input.items)) return fail('items must be a list of objects, one per listing.');
    const r = svc.report(ctx.session, input.items, typeof input.source === 'string' ? input.source : undefined);
    if (!r.card.items.length && input.items.length) return fail(`None of the items could be kept: ${r.problems.join('; ')}. Each needs an id or a url, and a title.`);
    const card: WatchCardData = r.card;
    return { content: r.text, meta: { watch: card } };
  },
};

export const WatchCreateTool: Tool<WatchCreateInput> = {
  name: 'WatchCreate',
  description: `Make a watch: a routine that runs a browser search on a schedule, keeps what it found, and tells the owner only what changed (new, gone, price drops). Use it when the owner says yes to "Watch this daily" after you showed results with WatchReport, or asks to watch a site. Watches only read: they never post, message, offer or buy.

- name: short, such as "Cars under $8,000".
- schedule: cron in the owner's timezone, "0 9 * * *" for daily at 09:00. Daily by default, at most a few times a day: sites limit personal accounts.
- url: the search page to start at, with the filters in its address when the site allows.
- prompt: the whole instruction for each run, which has no memory of this chat: what to look for, how the site shows price and place, what to skip.
- profile: the browser profile signed in to the site. Default: the one this chat browsed with, else the one signed in to the site.
- fields: other facts to read per item, such as ["year", "mileage"].
- filters: { minPrice, maxPrice, maxDistance, unit ("km" or "mi"), near, keywords, exclude }.
- notify: "change" (default), or "daily" for a summary after every run.
- currency: "USD", "EUR".

The items this chat showed become the watch's start, so its first run reports what changed since.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      schedule: { type: 'string' },
      url: { type: 'string' },
      prompt: { type: 'string' },
      profile: { type: 'string' },
      fields: { type: 'array', items: { type: 'string' } },
      filters: {
        type: 'object',
        properties: {
          minPrice: { type: 'number' },
          maxPrice: { type: 'number' },
          maxDistance: { type: 'number' },
          unit: { type: 'string', enum: ['km', 'mi'] },
          near: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
        },
      },
      notify: { type: 'string', enum: ['change', 'daily'] },
      currency: { type: 'string' },
    },
    required: ['name', 'schedule', 'url', 'prompt'],
    additionalProperties: false,
  },
  readOnly: false,
  optIn: true,
  summarize: (i) => `Watch "${i.name}" (${i.schedule})`,
  async run(input, ctx): Promise<ToolOutput> {
    const svc = ctx.host.watches;
    if (!svc) return fail(NO_WATCHES);
    try {
      const { routine, seeded } = svc.create(input, { sessionId: ctx.sessionId, agent: ctx.session?.agent });
      const next = routine.nextRunAt ? ` First run ${new Date(routine.nextRunAt).toISOString()}.` : '';
      const start = seeded ? ` It starts from the ${seeded} ${seeded === 1 ? 'item' : 'items'} shown here, so the first run reports what changed since.` : ' Its first run keeps what it finds and reports it as new.';
      const card: WatchCardData = { kind: 'created', routineId: routine.id, name: routine.name, schedule: routine.schedule, ...(routine.nextRunAt ? { nextRunAt: routine.nextRunAt } : {}), count: seeded };
      return {
        content: `Created watch "${routine.name}" (${routine.id}), schedule ${routine.schedule}${routine.timezone ? ` ${routine.timezone}` : ''}, browser profile ${routine.watch?.profile ?? 'default'}.${next}${start} The owner sees it on the Routines page.`,
        meta: { routineId: routine.id, watch: card },
      };
    } catch (err) {
      if (err instanceof WatchError) return fail(`Could not make the watch: ${err.message}`);
      return fail(`Could not make the watch: ${(err as Error).message}. Check the schedule format (e.g. "0 9 * * *").`);
    }
  },
};
