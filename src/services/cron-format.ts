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

/** Validate + normalize an HH:MM (24h) time string, returning {hour, minute}. */
export function parseTime(input: string): { hour: number; minute: number } {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(input || '');
  if (!m) {
    throw new Error(`Invalid time "${input}". Use 24-hour HH:MM, e.g. 11:15 or 09:00.`);
  }
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

/** Build a `m h * * d,d` cron from a days list + HH:MM time. */
export function buildCron(daysInput: string, timeInput: string): string {
  const days = parseDays(daysInput);
  const { hour, minute } = parseTime(timeInput);
  const dayField = days.slice().sort((a, b) => a - b).join(',');
  return `${minute} ${hour} * * ${dayField}`;
}

/**
 * Humanize a cron expression. For the simple weekly shape this yields e.g.
 * "Mon, Fri at 11:15". Anything else is returned verbatim (prefixed `cron:`).
 */
export function describeCron(cron: string, timezone?: string): string {
  const tzSuffix = timezone ? ` ${timezone}` : '';
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

  if (dow === '*') return `daily at ${time}${tzSuffix}`;

  const nums = dow
    .split(',')
    .map((d) => parseInt(d, 10))
    .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 7)
    .map((n) => n % 7);
  if (nums.length === 0) return `cron: ${cron}`;

  const labels = [...new Set(nums)]
    .sort((a, b) => dayWeight(a) - dayWeight(b))
    .map((n) => NUM_TO_LABEL[n]);
  return `${labels.join(', ')} at ${time}${tzSuffix}`;
}
