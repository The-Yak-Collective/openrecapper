/**
 * Call naming scheme:
 *   - Monday standing call  -> "CADS <ISODATE>"
 *   - Friday standing call  -> "GS <ISODATE>"
 *   - ad hoc calls          -> "<name> <ISODATE>"
 * ISODATE is the local (America/New_York) date in YYYY-MM-DD form.
 */

const TZ = process.env.SCHEDULED_TIMEZONE || 'America/New_York';

/** YYYY-MM-DD for the given date in the configured timezone. */
export function isoDate(date: Date = new Date()): string {
  // en-CA locale yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Numeric weekday (0=Sun .. 6=Sat) in the configured timezone. */
function weekday(date: Date): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/**
 * Name for a scheduled standing call based on the day it runs.
 * Monday -> CADS, Friday -> GS. Other days fall back to a generic label so a
 * mis-scheduled run still gets a sensible name.
 */
export function scheduledCallName(date: Date = new Date()): string {
  const wd = weekday(date);
  const prefix = wd === 1 ? 'CADS' : wd === 5 ? 'GS' : 'Call';
  return `${prefix} ${isoDate(date)}`;
}

/** Name for an ad hoc call: caller-supplied name + ISODATE. */
export function adHocCallName(name: string, date: Date = new Date()): string {
  const clean = (name || '').trim().replace(/\s+/g, ' ') || 'Ad hoc';
  return `${clean} ${isoDate(date)}`;
}

/** Filesystem-safe slug from a call name (for filenames / R2 keys). */
export function slugifyCallName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
