/**
 * The routine editor's schedule field takes words or cron (spec 11.5):
 * "every weekday at 7:30", "every 30 min", "Sundays at 20:00", "daily at 3am",
 * "*\/30 * * * *", "@every 30m". The hub only understands cron, "@every" and
 * "@once", so words are turned into one of those before preview and save.
 */

export type ParsedSchedule = { expr: string; fromWords: boolean } | { error: string };

const DAYS: Array<[RegExp, number]> = [
  [/^sun(day)?s?$/, 0],
  [/^mon(day)?s?$/, 1],
  [/^tue(s|sday)?s?$/, 2],
  [/^wed(s|nesday)?s?$/, 3],
  [/^thu(r|rs|rsday)?s?$/, 4],
  [/^fri(day)?s?$/, 5],
  [/^sat(urday)?s?$/, 6],
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const UNIT: Record<string, 'm' | 'h' | 'd' | 's'> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "7", "7:30", "07.30", "7am", "7:30 pm", "19h", "noon", "midnight" -> [hour, minute] */
export function parseTime(raw: string): [number, number] | null {
  const s = raw.trim().toLowerCase();
  if (s === 'noon' || s === 'midday') return [12, 0];
  if (s === 'midnight') return [0, 0];
  const m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|h)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/** True when the text already is something the hub accepts. */
function isRaw(s: string): boolean {
  if (s.startsWith('@')) return true;
  const f = s.split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*/,\-]+$/.test(x));
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Words or cron to a hub schedule. Returns null for an empty field, an
 * error sentence when the words are not understood.
 */
export function toSchedule(input: string, now = new Date()): ParsedSchedule | null {
  const raw = input.trim();
  if (!raw) return null;
  if (isRaw(raw)) return { expr: raw.replace(/\s+/g, ' '), fromWords: false };

  let s = raw
    .toLowerCase()
    .replace(/[,;]/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // intervals: "every 30 min", "every 2 hours", "every minute", "hourly", "daily"
  if (/^(hourly|every hour|each hour)$/.test(s)) return { expr: '0 * * * *', fromWords: true };
  if (/^(every|each) (minute|min)$/.test(s)) return { expr: '@every 1m', fromWords: true };
  const iv = s.match(/^(?:every|each) (\d+) ?([a-z]+)$/);
  if (iv && UNIT[iv[2]]) {
    const n = Number(iv[1]);
    if (!n) return { error: 'Use a number above zero, like every 30 min.' };
    const u = UNIT[iv[2]];
    if (u === 's' && n < 60) return { error: 'Routines run at most once a minute. Try every 1 min.' };
    return { expr: `@every ${n}${u}`, fromWords: true };
  }

  // the time of day: after "at", or the last token
  let time: [number, number] | null = null;
  const at = s.match(/\bat (\S+(?: ?[ap]m)?)/);
  if (at) {
    time = parseTime(at[1]);
    if (!time) return { error: `Could not read the time "${at[1]}". Write it like 7:30 or 18:00.` };
    s = s.replace(at[0], ' ').replace(/\s+/g, ' ').trim();
  } else {
    const tail = s.match(/(\d{1,2}(?:[:.]\d{2})? ?(?:am|pm)?|noon|midnight)$/);
    if (tail && !/\d{4}-\d{2}-\d{2}$/.test(s)) {
      time = parseTime(tail[1]);
      if (time) s = s.slice(0, -tail[0].length).trim();
    }
  }

  // one time: "tomorrow at 9", "today at 18:00", "on 2026-10-20 at 9", "once on 19 Oct at 09:00"
  const date = s.match(/(\d{4}-\d{2}-\d{2})/);
  const named = s.match(/\b(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (/\b(tomorrow|today|once)\b/.test(s) || date || named) {
    let d = date ? new Date(`${date[1]}T00:00`) : new Date(now);
    if (named && !date) {
      d = new Date(now.getFullYear(), MONTHS.indexOf(named[2]), Number(named[1]));
      if (d.getTime() < new Date(now).setHours(0, 0, 0, 0)) d.setFullYear(d.getFullYear() + 1);
    }
    if (Number.isNaN(d.getTime())) return { error: 'Write the date like 2026-10-20.' };
    if (/\btomorrow\b/.test(s)) d.setDate(d.getDate() + 1);
    const [h, m] = time ?? [9, 0];
    d.setHours(h, m, 0, 0);
    return { expr: `@once ${localIso(d)}`, fromWords: true };
  }

  if (!time) {
    if (/^(daily|every day|each day)$/.test(s)) return { expr: '0 9 * * *', fromWords: true };
    return { error: 'Add a time, like every weekday at 7:30, or an interval, like every 30 min.' };
  }
  const [hh, mm] = time;

  // month days: "monthly on day 1", "on the 1st of every month", "every month on the 15th"
  const dom = s.match(/(?:day|the) (\d{1,2})(?:st|nd|rd|th)?\b/) ?? s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (/\bmonth(ly)?\b/.test(s)) {
    const n = dom ? Number(dom[1]) : 1;
    if (n < 1 || n > 31) return { error: 'Use a day of the month from 1 to 31.' };
    return { expr: `${mm} ${hh} ${n} * *`, fromWords: true };
  }

  // weekdays, weekends, named days, or every day
  const day = (w: string) => DAYS.find(([re]) => re.test(w))?.[1];
  // "sunday to friday" reads as a range
  s = s.replace(/\b([a-z]+) (?:to|through|thru|until) ([a-z]+)\b/g, (m, a: string, b: string) => (day(a) !== undefined && day(b) !== undefined ? `${a}-${b}` : m));
  const words = s.split(' ').filter((w) => w && !['every', 'each', 'on', 'the', 'at', 'run', 'runs', 'from'].includes(w));
  let dow = '*';
  if (words.some((w) => /^weekdays?$/.test(w) || w === 'workdays')) dow = '1-5';
  else if (words.some((w) => /^weekends?$/.test(w))) dow = '0,6';
  else {
    const days: number[] = [];
    for (const w of words) {
      const range = w.split('-');
      const a = day(range[0]);
      const b = range.length === 2 ? day(range[1]) : undefined;
      if (a !== undefined && b !== undefined) for (let i = a; i !== (b + 1) % 7; i = (i + 1) % 7) days.push(i);
      else if (a !== undefined && range.length === 1) days.push(a);
      else if (!/^(daily|day|days|night|nightly|morning|evening)$/.test(w)) return { error: `Could not read "${w}". Try every weekday at 7:30, Sundays at 20:00 or a cron line.` };
    }
    if (days.length) {
      const list = [...new Set(days)].sort((a, b) => a - b);
      // 1,2,3,4,5 reads better as 1-5 (and describes as "Weekdays")
      const run = list.length >= 3 && list.every((d, i) => i === 0 || d === list[i - 1] + 1);
      dow = run ? `${list[0]}-${list[list.length - 1]}` : list.join(',');
    }
  }
  return { expr: `${mm} ${hh} * * ${dow}`, fromWords: true };
}

/** A few phrases the field understands, for the help line. */
export const SCHEDULE_EXAMPLES = ['every weekday at 7:30', 'every 30 min', 'daily at 03:00', 'Sundays at 20:00'];
