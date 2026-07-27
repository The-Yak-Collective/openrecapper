/**
 * Helpers to translate the user-friendly `/schedule` inputs (a comma list of
 * weekdays + an HH:MM time) to/from standard 5-field cron expressions.
 *
 * We deliberately only generate and pretty-print the simple "weekly at a time"
 * shape (`m h * * d,d`). Any other cron entered by hand still runs fine — it is
 * just echoed verbatim by `describeCron` rather than humanized.
 */

// Cron day-of-week numbers: 0 = Sunday .. 6 = Saturday.
const DAY_TO_NUM: Record<string, number> = {
  sun: 0, sunday: 0, su: 0, u: 0,
  mon: 1, monday: 1, mo: 1, m: 1,
  tue: 2, tues: 2, tuesday: 2, tu: 2,
  wed: 3, weds: 3, wednesday: 3, we: 3, w: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, th: 4,
  fri: 5, friday: 5, fr: 5, f: 5,
  sat: 6, saturday: 6, sa: 6,
};

const NUM_TO_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Group aliases expand to multiple days.
const GROUP_ALIASES: Record<string, number[]> = {
  weekday: [1, 2, 3, 4, 5],
  weekdays: [1, 2, 3, 4, 5],
  weekend: [0, 6],
  weekends: [0, 6],
  daily: [0, 1, 2, 3, 4, 5, 6],
  everyday: [0, 1, 2, 3, 4, 5, 6],
  all: [0, 1, 2, 3, 4, 5, 6],
};

/** Display ordering weight: Monday first, Sunday last. */
function dayWeight(n: number): number {
  return n === 0 ? 7 : n;
}

/** Short label ("Mon") for a cron day number (0=Sun..6=Sat). */
export function dayLabel(n: number): string {
  return NUM_TO_LABEL[((n % 7) + 7) % 7];
}

/**
 * Parse the simple "weekly at a time" cron shape (`m h * * d,d`).
 * Returns { minute, hour, days } or null if the cron is not that shape.
 */
export function parseSimpleCron(
  cron: string,
): { minute: number; hour: number; days: number[] } | null {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;
  if (!/^\d{1,2}$/.test(minField) || !/^\d{1,2}$/.test(hourField)) return null;
  const minute = parseInt(minField, 10);
  const hour = parseInt(hourField, 10);
  if (minute > 59 || hour > 23) return null;

  let days: number[];
  if (dow === '*') {
    days = [0, 1, 2, 3, 4, 5, 6];
  } else {
    if (!/^[0-7](,[0-7])*$/.test(dow)) return null;
    days = [...new Set(dow.split(',').map((d) => parseInt(d, 10) % 7))].sort(
      (a, b) => dayWeight(a) - dayWeight(b),
    );
  }
  return { minute, hour, days };
}

/**
 * Parse a comma list of days into sorted, unique cron day numbers.
 * Accepts names ("mon", "monday"), numbers ("0".."7", 7=Sun) and group aliases
 * ("weekdays", "daily", "weekends"). Throws on an unrecognized token.
 */
export function parseDays(input: string): number[] {
  const tokens = (input || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('No days provided.');

  const set = new Set<number>();
  for (const tok of tokens) {
    if (GROUP_ALIASES[tok]) {
      GROUP_ALIASES[tok].forEach((n) => set.add(n));
      continue;
    }
    if (/^[0-7]$/.test(tok)) {
      set.add(parseInt(tok, 10) % 7); // 7 -> 0 (Sunday)
      continue;
    }
    const num = DAY_TO_NUM[tok];
    if (num === undefined) {
      throw new Error(
        `Unrecognized day "${tok}". Use names like mon,tue,fri or groups like weekdays/daily.`,
      );
    }
    set.add(num);
  }
  return [...set].sort((a, b) => dayWeight(a) - dayWeight(b));
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Parse the `every` option into a whole number of weeks between fires.
 * Accepts: ""/"weekly"/"1" -> 1; "biweekly"/"fortnightly"/"2"/"2 weeks"/
 * "every 2 weeks" -> 2; and "N"/"N weeks" for any N in 1..12.
 * Throws on anything unrecognized or out of range.
 */
export function parseInterval(input: string | null | undefined): number {
  const raw = (input || '').trim().toLowerCase();
  if (!raw || raw === 'weekly' || raw === 'week' || raw === 'every week') return 1;
  if (raw === 'biweekly' || raw === 'bi-weekly' || raw === 'fortnightly' || raw === 'fortnight') {
    return 2;
  }
  // "2", "2 weeks", "every 2 weeks", "every-2-weeks"
  const m = /^(?:every\s+)?(\d{1,2})(?:\s*(?:-|\s)?\s*weeks?)?$/.exec(raw);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 12) return n;
    throw new Error(`"every" must be between 1 and 12 weeks (got ${n}).`);
  }
  throw new Error(
    `Unrecognized "every" value "${input}". Use weekly, biweekly, or "N weeks" (1-12).`,
  );
}

/** Validate + normalize a YYYY-MM-DD date, returning {year, month, day} (month 1-12). */
export function parseDate(input: string): { year: number; month: number; day: number } {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(input || '');
  if (!m) {
    throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, e.g. 2026-08-15.`);
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12) throw new Error(`Invalid month in "${input}".`);
  // Reject impossible calendar dates (e.g. 2026-02-31) using a round-trip.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`"${input}" is not a real calendar date.`);
  }
  return { year, month, day };
}

/**
 * Build a one-off cron (`m h D M *`) for a specific calendar date + time.
 * Day-of-week is left `*`; the day-of-month + month pin it to a single date
 * within the year. (cron has no year field, so the scheduler deletes the
 * one-off right after it fires to prevent it recurring next year.)
 */
export function buildOneOffCron(dateInput: string, timeInput: string): string {
  const { month, day } = parseDate(dateInput);
  const { hour, minute } = parseTime(timeInput);
  return `${minute} ${hour} ${day} ${month} *`;
}

/**
 * Parse the one-off cron shape (`m h D M *`). Returns {minute,hour,day,month}
 * or null if the cron is not that shape.
 */
export function parseOneOffCron(
  cron: string,
): { minute: number; hour: number; day: number; month: number } | null {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts;
  if (dowF !== '*') return null;
  if (![minF, hourF, domF, monF].every((f) => /^\d{1,2}$/.test(f))) return null;
  const minute = parseInt(minF, 10);
  const hour = parseInt(hourF, 10);
  const day = parseInt(domF, 10);
  const month = parseInt(monF, 10);
  if (minute > 59 || hour > 23 || day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { minute, hour, day, month };
}

/** The civil (wall-clock) date in a timezone as a UTC-midnight day index. */
function civilDayIndex(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
}

/**
 * Whole weeks between an anchor date and `now`, evaluated as civil dates in the
 * given timezone. Robust across year boundaries and DST (counts calendar days,
 * not elapsed hours). Negative if `now` precedes the anchor.
 */
export function weeksSinceAnchor(anchor: string, timezone: string, now: Date = new Date()): number {
  const { year, month, day } = parseDate(anchor);
  const anchorDay = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  const nowDay = civilDayIndex(now, timezone);
  return Math.floor((nowDay - anchorDay) / 7);
}

/**
 * Whether an interval schedule should fire in the current week. Weekly (or
 * missing/1 interval, or no anchor) always fires. Otherwise fires only when the
 * whole-week count since the anchor is a multiple of intervalWeeks.
 */
export function shouldFireThisWeek(
  intervalWeeks: number | undefined,
  anchor: string | undefined,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const n = intervalWeeks ?? 1;
  if (n <= 1 || !anchor) return true;
  const weeks = weeksSinceAnchor(anchor, timezone, now);
  if (weeks < 0) return false; // before the anchor week — not yet started
  return weeks % n === 0;
}

/** Validate + normalize an HH:MM (24h) time string, returning {hour, minute}. */
export function parseTime(input: string): { hour: number; minute: number } {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(input || '');
  if (!m) {
    throw new Error(`Invalid time "${input}". Use 24-hour HH:MM, e.g. 11:15 or 09:00.`);
  }
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

/** Civil date string (YYYY-MM-DD) for a UTC-midnight day index. */
function dayIndexToDate(dayIndex: number): string {
  const d = new Date(dayIndex * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Current civil {dayIndex, weekday(0=Sun), minuteOfDay} in a timezone. */
function civilNow(timezone: string, now: Date): { dayIndex: number; weekday: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some ICU builds emit "24" at midnight
  const minute = parseInt(get('minute'), 10);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[get('weekday')];
  const dayIndex = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return { dayIndex, weekday, minuteOfDay: hour * 60 + minute };
}

/**
 * The civil date (YYYY-MM-DD) of the next time a weekly `days`+`time` schedule
 * will fire, in the given timezone. Used to anchor interval (biweekly) phase so
 * the first real recording is the next matching occurrence. Assumes `days` is
 * non-empty cron day numbers (0=Sun..6=Sat).
 */
export function nextFireDate(
  days: number[],
  hour: number,
  minute: number,
  timezone: string,
  now: Date = new Date(),
): string {
  const set = new Set(days.map((d) => ((d % 7) + 7) % 7));
  const { dayIndex, weekday, minuteOfDay } = civilNow(timezone, now);
  const target = hour * 60 + minute;
  for (let offset = 0; offset <= 7; offset++) {
    const wd = (weekday + offset) % 7;
    if (!set.has(wd)) continue;
    if (offset === 0 && minuteOfDay >= target) continue; // today's slot already passed
    return dayIndexToDate(dayIndex + offset);
  }
  // Fallback (only if days somehow empty): today.
  return dayIndexToDate(dayIndex);
}

/** Build a `m h * * d,d` cron from a days list + HH:MM time. */
export function buildCron(daysInput: string, timeInput: string): string {
  const days = parseDays(daysInput);
  const { hour, minute } = parseTime(timeInput);
  const dayField = days.slice().sort((a, b) => a - b).join(',');
  return `${minute} ${hour} * * ${dayField}`;
}

/** Extra schedule attributes that affect how a cron is described. */
export interface DescribeOpts {
  intervalWeeks?: number;
  anchor?: string;
  oneOff?: boolean;
}

/**
 * Humanize a cron expression. For the simple weekly shape this yields e.g.
 * "Mon, Fri at 11:15"; for one-offs, "once on Aug 15 at 11:15"; and for
 * intervals, "every 2 weeks on Wed at 11:15". Anything else is returned
 * verbatim (prefixed `cron:`).
 */
export function describeCron(cron: string, timezone?: string, opts?: DescribeOpts): string {
  const tzSuffix = timezone ? ` ${timezone}` : '';

  // One-off: a specific calendar date + time.
  if (opts?.oneOff) {
    const oneOff = parseOneOffCron(cron);
    if (oneOff) {
      const hh = String(oneOff.hour).padStart(2, '0');
      const mm = String(oneOff.minute).padStart(2, '0');
      return `once on ${MONTH_NAMES[oneOff.month - 1]} ${oneOff.day} at ${hh}:${mm}${tzSuffix}`;
    }
  }

  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return `cron: ${cron}`;

  const [minField, hourField, dom, mon, dow] = parts;
  // Only humanize the plain "every selected weekday at a fixed time" shape.
  const simple =
    dom === '*' &&
    mon === '*' &&
    /^\d{1,2}$/.test(minField) &&
    /^\d{1,2}$/.test(hourField);
  if (!simple) return `cron: ${cron}`;

  const hh = String(parseInt(hourField, 10)).padStart(2, '0');
  const mm = String(parseInt(minField, 10)).padStart(2, '0');
  const time = `${hh}:${mm}`;

  const n = opts?.intervalWeeks ?? 1;
  // Cadence prefix for interval schedules: "every 2 weeks ", "every 3 weeks ".
  const cadence = n > 1 ? `every ${n} weeks ` : '';
  const anchorSuffix = n > 1 && opts?.anchor ? ` (from ${opts.anchor})` : '';

  if (dow === '*') return `${cadence ? cadence + '' : ''}daily at ${time}${tzSuffix}${anchorSuffix}`;

  const nums = dow
    .split(',')
    .map((d) => parseInt(d, 10))
    .filter((num) => !Number.isNaN(num) && num >= 0 && num <= 7)
    .map((num) => num % 7);
  if (nums.length === 0) return `cron: ${cron}`;

  const labels = [...new Set(nums)]
    .sort((a, b) => dayWeight(a) - dayWeight(b))
    .map((num) => NUM_TO_LABEL[num]);
  const prefix = cadence ? `${cadence}on ` : '';
  return `${prefix}${labels.join(', ')} at ${time}${tzSuffix}${anchorSuffix}`;
}
