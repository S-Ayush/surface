/**
 * Due dates are calendar dates, `YYYY-MM-DD`, with no time zone (domain-model §1). `parseDueDate`
 * reads the small fixed English grammar of SPEC-012 §4.1; weeks start on Monday in M1.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** Index 0 is Monday, matching the Monday week start. */
const WEEKDAY_NAMES = [
  ['monday', 'mon'],
  ['tuesday', 'tue', 'tues'],
  ['wednesday', 'wed'],
  ['thursday', 'thu', 'thur', 'thurs'],
  ['friday', 'fri'],
  ['saturday', 'sat'],
  ['sunday', 'sun'],
] as const;

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

interface Ymd {
  readonly y: number;
  readonly m: number; // 1-12
  readonly d: number;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isValidYmd(y: number, m: number, d: number): boolean {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function toYmd(date: string): Ymd | null {
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return isValidYmd(y, m, d) ? { y, m, d } : null;
}

function format({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function utc({ y, m, d }: Ymd): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getTime();
}

function fromUtc(ms: number): Ymd | null {
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  if (Number.isNaN(y) || y < 1 || y > 9999) return null;
  return { y, m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function addDays(from: Ymd, days: number): Ymd | null {
  return fromUtc(utc(from) + days * DAY_MS);
}

/** Adds months and clamps the day (Jan 31 + 1 month is Feb 28 or 29). */
function addMonths(from: Ymd, months: number): Ymd | null {
  const index = from.y * 12 + (from.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  if (y < 1 || y > 9999) return null;
  return { y, m, d: Math.min(from.d, daysInMonth(y, m)) };
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(date: Ymd): number {
  return (new Date(utc(date)).getUTCDay() + 6) % 7;
}

function lookupWeekday(word: string): number {
  return WEEKDAY_NAMES.findIndex((names) => (names as readonly string[]).includes(word));
}

function lookupMonth(word: string): number {
  // A full name or a prefix of at least three letters ("sep", "sept"), so "ma" matches nothing.
  if (word.length < 3) return -1;
  return MONTH_NAMES.findIndex((name) => name.startsWith(word));
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** The next time month/day occurs on or after `today` (Feb 29 waits for a leap year). */
function nextMonthDay(m: number, d: number, today: Ymd): Ymd | null {
  for (let y = today.y; y <= today.y + 8; y++) {
    if (!isValidYmd(y, m, d)) continue;
    const candidate = { y, m, d };
    if (compareYmd(candidate, today) >= 0) return candidate;
  }
  return null;
}

/**
 * The date `text` means, as `YYYY-MM-DD`, or null when it isn't a date. `today` is `YYYY-MM-DD` in
 * the user's own calendar, passed in so the function stays pure. Never throws.
 *
 * Forms (case and extra spaces ignored): `2026-12-03`; `today`; `tomorrow`; a weekday (`friday`,
 * `fri`: the next one after today); `next friday` (that day in next week); `in 3 days`, `in 2
 * weeks`, `in 1 month`; `end of week` (Sunday), `end of month`; `dec 3`, `3 dec`, `december 3rd`,
 * with an optional year (`dec 3 2027`). A month and day without a year is the next one on or
 * after today.
 */
export function parseDueDate(text: string, today: string): string | null {
  const now = toYmd(today);
  if (!now) return null;
  const input = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (input === '' || input.length > 64) return null;

  const iso = toYmd(input);
  if (iso) return format(iso);
  if (ISO_DATE.test(input)) return null;

  if (input === 'today') return format(now);
  if (input === 'tomorrow') {
    const next = addDays(now, 1);
    return next && format(next);
  }

  const nextWeekday = /^next ([a-z]+)$/.exec(input);
  if (nextWeekday?.[1] !== undefined) {
    const target = lookupWeekday(nextWeekday[1]);
    if (target < 0) return null;
    const mondayNextWeek = addDays(now, 7 - weekdayIndex(now));
    const date = mondayNextWeek && addDays(mondayNextWeek, target);
    return date && format(date);
  }

  const weekday = lookupWeekday(input);
  if (weekday >= 0) {
    const ahead = ((weekday - weekdayIndex(now) + 6) % 7) + 1;
    const date = addDays(now, ahead);
    return date && format(date);
  }

  const relative = /^in (\d{1,4}) (day|days|week|weeks|month|months)$/.exec(input);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const n = Number(relative[1]);
    const unit = relative[2];
    const date = unit.startsWith('month')
      ? addMonths(now, n)
      : addDays(now, unit.startsWith('week') ? n * 7 : n);
    return date && format(date);
  }

  if (input === 'end of week') {
    const date = addDays(now, 6 - weekdayIndex(now));
    return date && format(date);
  }
  if (input === 'end of month') {
    return format({ ...now, d: daysInMonth(now.y, now.m) });
  }

  const monthFirst = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(input);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?:,? (\d{4}))?$/.exec(input);
  const parts =
    monthFirst?.[1] !== undefined && monthFirst[2] !== undefined
      ? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
      : dayFirst?.[1] !== undefined && dayFirst[2] !== undefined
        ? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
        : null;
  if (parts) {
    const month = lookupMonth(parts.month);
    if (month < 0) return null;
    const day = Number(parts.day);
    if (parts.year !== undefined) {
      const y = Number(parts.year);
      return isValidYmd(y, month + 1, day) ? format({ y, m: month + 1, d: day }) : null;
    }
    const date = nextMonthDay(month + 1, day, now);
    return date && format(date);
  }
  return null;
}

/**
 * A short label for a due date: "Dec 3", with the year when it isn't `today`'s year ("Dec 3, 2027").
 * An invalid date comes back unchanged.
 */
export function formatDueDate(date: string, today: string): string {
  const ymd = toYmd(date);
  if (!ymd) return date;
  const label = `${SHORT_MONTHS[ymd.m - 1] ?? ''} ${ymd.d}`;
  return ymd.y === toYmd(today)?.y ? label : `${label}, ${ymd.y}`;
}
