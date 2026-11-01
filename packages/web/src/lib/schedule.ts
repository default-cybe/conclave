/**
 * Routine schedules in words and on today's axis. Understands 5 field cron,
 * "@every 30m" and "@once <iso date>", the forms the hub accepts.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (Number.isNaN(a)) return null;
      lo = a;
      hi = b === undefined || Number.isNaN(b) ? (stepStr ? max : a) : b;
    }
    if (lo < min || hi > max || !step) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  raw: string[];
}

export function parseCron(expr: string): Cron | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets = [parseField(f[0], 0, 59), parseField(f[1], 0, 23), parseField(f[2], 1, 31), parseField(f[3], 1, 12), parseField(f[4].replace(/7/g, '0'), 0, 6)];
  if (sets.some((s) => !s)) return null;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  return { minute, hour, dom, month, dow, raw: f };
}

/** "@every 30m" -> 30 * 60_000 */
export function everyMs(schedule: string): number | undefined {
  const m = schedule.trim().match(/^@every\s+(\d+)\s*(s|m|h|d)$/);
  if (!m) return undefined;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's'];
}

const pad = (n: number) => String(n).padStart(2, '0');

function daysWords(dow: string): string | undefined {
  if (dow === '*') return undefined;
  if (dow === '1-5') return 'Weekdays';
  if (dow === '0,6' || dow === '6,0') return 'Weekends';
  if (dow === '0-5') return 'Sunday to Friday';
  if (/^\d$/.test(dow)) return `${DAY_NAMES[Number(dow) % 7]}s`;
  const parts = dow.split(',');
  if (parts.every((p) => /^\d$/.test(p))) return parts.map((p) => DAY_NAMES[Number(p) % 7].slice(0, 3)).join(', ');
  return undefined;
}

/**
 * "Every 30 min", "Weekdays at 07:30", "Daily at 03:00", "Mondays at 09:00",
 * "Once on 19 Oct at 09:00". Falls back to the raw expression.
 */
export function describeSchedule(schedule: string | undefined): string {
  if (!schedule) return '';
  const s = schedule.trim();
  const every = everyMs(s);
  if (every) {
    const min = every / 60_000;
    if (min < 1) return `Every ${every / 1000} s`;
    if (min < 60) return `Every ${min} min`;
    if (min % 1440 === 0) return min === 1440 ? 'Daily' : `Every ${min / 1440} days`;
    if (min % 60 === 0) return min === 60 ? 'Hourly' : `Every ${min / 60} hours`;
    return `Every ${min} min`;
  }
  if (s.startsWith('@once')) {
    const t = new Date(s.slice(5).trim());
    if (!Number.isNaN(t.getTime())) return `Once on ${t.getDate()} ${t.toLocaleDateString('en-GB', { month: 'short' })} at ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    return s;
  }
  if (s === '@hourly') return 'Hourly';
  if (s === '@daily' || s === '@midnight') return 'Daily at 00:00';
  if (s === '@weekly') return 'Sundays at 00:00';
  const c = parseCron(s);
  if (!c) return s;
  const [mi, h, dom, mon, dow] = c.raw;
  const stepMin = mi.match(/^\*\/(\d+)$/);
  if (stepMin && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${stepMin[1]} min`;
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return mi === '0' ? 'Hourly' : `Hourly at :${pad(Number(mi))}`;
  const stepH = h.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(mi) && stepH && dom === '*' && mon === '*') return `Every ${stepH[1]} hours`;
  if (/^\d+$/.test(mi) && /^\d+(,\d+)*$/.test(h) && mon === '*') {
    const times = h
      .split(',')
      .map((x) => `${pad(Number(x))}:${pad(Number(mi))}`)
      .join(' and ');
    if (dom === '*') {
      const days = daysWords(dow);
      return `${days ?? 'Daily'} at ${times}`;
    }
    if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${times}`;
  }
  return s;
}

/** Start of the local day for `now`. */
export function dayStart(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Every time a schedule fires on the local day that contains `now`.
 * `anchor` aligns @every intervals (the last run, or the next run).
 */
export function occurrencesToday(schedule: string, now = Date.now(), anchor?: number): number[] {
  const start = dayStart(now);
  const end = start + 86_400_000;
  const every = everyMs(schedule);
  if (every) {
    const base = anchor ?? start;
    const first = base - Math.floor((base - start) / every) * every;
    const out: number[] = [];
    for (let t = first; t < end && out.length < 2000; t += every) if (t >= start) out.push(t);
    return out;
  }
  if (schedule.trim().startsWith('@once')) {
    const t = new Date(schedule.trim().slice(5).trim()).getTime();
    return t >= start && t < end ? [t] : [];
  }
  const c = parseCron(schedule);
  if (!c) return [];
  const d = new Date(start);
  if (!c.month.has(d.getMonth() + 1) || !c.dom.has(d.getDate()) || !c.dow.has(d.getDay())) return [];
  const out: number[] = [];
  for (const h of [...c.hour].sort((a, b) => a - b)) for (const m of [...c.minute].sort((a, b) => a - b)) out.push(start + h * 3_600_000 + m * 60_000);
  return out;
}
