/**
 * Calendar arithmetic for the date picker. Dates are `YYYY-MM-DD` strings with no time zone
 * (domain-model §1), computed in UTC so the user's zone never shifts a day. Weeks start on Monday
 * in M1 (SPEC-012 §4.1). Names come from `Intl.DateTimeFormat`, so other languages need no table.
 */

const DAY_MS = 86_400_000;

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  date: string;
  day: number;
  /** In the month being shown (the others pad the first and last week). */
  inMonth: boolean;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

export function parseDate(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(2000, m - 1, d));
  probe.setUTCFullYear(y);
  const ok = m >= 1 && m <= 12 && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  return ok ? { y, m, d } : null;
}

function format(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

function toDate(date: string): Date {
  const parts = parseDate(date);
  const out = new Date(0);
  if (parts) out.setUTCFullYear(parts.y, parts.m - 1, parts.d);
  return out;
}

export function addDays(date: string, days: number): string {
  return format(new Date(toDate(date).getTime() + days * DAY_MS));
}

/** Moves by whole months, clamping the day (Mar 31 → Feb 28). */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parseDate(date) ?? { y: 1970, m: 1, d: 1 };
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(0);
  last.setUTCFullYear(year, month, 0);
  const out = new Date(0);
  out.setUTCFullYear(year, month - 1, Math.min(d, last.getUTCDate()));
  return format(out);
}

/** The weeks of the month containing `date`, Monday first, padded to whole weeks. */
export function monthWeeks(date: string): CalendarDay[][] {
  const { y, m } = parseDate(date) ?? { y: 1970, m: 1 };
  const first = `${pad(y, 4)}-${pad(m, 2)}-01`;
  const monthEnd = addDays(addMonths(first, 1), -1);
  const lead = (toDate(first).getUTCDay() + 6) % 7;
  const weeks: CalendarDay[][] = [];
  let start = addDays(first, -lead);
  while (start <= monthEnd) {
    weeks.push(
      Array.from({ length: 7 }, (_, d) => {
        const cell = addDays(start, d);
        const parts = parseDate(cell);
        return { date: cell, day: parts?.d ?? 0, inMonth: parts?.m === m && parts.y === y };
      }),
    );
    start = addDays(start, 7);
  }
  return weeks;
}

/** "November 2026". */
export function monthTitle(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(toDate(date));
}

/** Weekday names, Monday first: `short` for the header, `long` for assistive technology. */
export function weekdayNames(locale?: string): { short: string; long: string }[] {
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, i) => {
    const day = toDate(addDays('2024-01-01', i));
    return { short: short.format(day), long: long.format(day) };
  });
}

/** "Thursday, November 12, 2026": the accessible name of a day button. */
export function fullDate(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(
    toDate(date),
  );
}
