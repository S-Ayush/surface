/**
 * Absolute and relative time values in filters (SPEC-003 §7.4). Relative values
 * are resolved here, once, for both the client and the server, so the two can't
 * disagree about "now", time zones or daylight saving.
 */

/** Signed ISO-8601 duration limited to fixed-length units: weeks, days, hours, minutes. */
export interface Duration {
  sign: 1 | -1;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
}

const DURATION = /^([+-])?P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?)?$/;

export function parseDuration(text: string): Duration | undefined {
  const m = DURATION.exec(text);
  if (!m) return undefined;
  const [, sign, weeks, days, hours, minutes] = m;
  const hasDate = weeks !== undefined || days !== undefined;
  const hasTime = hours !== undefined || minutes !== undefined;
  if (!hasDate && !hasTime) return undefined; // "P", "PT"
  if (text.includes('T') && !hasTime) return undefined; // "P1DT"
  return {
    sign: sign === '-' ? -1 : 1,
    weeks: Number(weeks ?? 0),
    days: Number(days ?? 0),
    hours: Number(hours ?? 0),
    minutes: Number(minutes ?? 0),
  };
}

/** The instants filters accept: years 1–9999 in UTC, as Postgres and ISO strings do. */
export const MIN_INSTANT = Date.parse('0001-01-01T00:00:00.000Z');
export const MAX_INSTANT = Date.parse('9999-12-31T23:59:59.999Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `now` shifted by an exact number of milliseconds (a day is always 24 h). */
export function shiftInstant(now: number, d: Duration): number {
  return now + d.sign * (d.weeks * 7 * DAY + d.days * DAY + d.hours * HOUR + d.minutes * MINUTE);
}

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayParts(text: string): { y: number; m: number; d: number } | undefined {
  const match = DAY_TEXT.exec(text);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const parts = { y: Number(y), m: Number(m), d: Number(d) };
  // Round-trip through a UTC date to reject 2026-02-30 and friends.
  return formatDay(utcDate(parts.y, parts.m, parts.d)) === text ? parts : undefined;
}

export function isValidDay(text: string): boolean {
  return dayParts(text) !== undefined && text >= '0001-01-01';
}

function utcDate(y: number, m: number, d: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d); // unlike Date.UTC, years 0–99 stay literal
  return date;
}

function formatDay(date: Date): string {
  const y = date.getUTCFullYear();
  if (y < 1 || y > 9999) return 'out-of-range';
  return `${String(y).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Today's calendar date in `timeZone`. Throws RangeError on an unknown zone. */
export function todayIn(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return formatDay(utcDate(get('year'), get('month'), get('day')));
}

/** `day` plus a number of calendar days, or undefined outside years 1–9999. */
export function addDays(day: string, days: number): string | undefined {
  const p = dayParts(day);
  if (!p) return undefined;
  const result = formatDay(utcDate(p.y, p.m, p.d + days));
  return result === 'out-of-range' ? undefined : result;
}

const INSTANT_TEXT =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/**
 * Milliseconds since the epoch for an ISO-8601 date-time with an explicit
 * offset (`2026-11-06T09:00:00Z`, `…+05:30`), or undefined.
 */
export function parseInstant(text: string): number | undefined {
  const m = INSTANT_TEXT.exec(text);
  if (!m?.[1] || !isValidDay(m[1])) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}
