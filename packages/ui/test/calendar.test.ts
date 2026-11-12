// The date picker's calendar arithmetic (SPEC-012 §3.5, §4.1): Monday weeks, no time zones.
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  fullDate,
  monthTitle,
  monthWeeks,
  parseDate,
  weekdayNames,
} from '../src/components/DatePicker/calendar.js';

describe('calendar', () => {
  it('parses only real calendar dates', () => {
    expect(parseDate('2026-11-12')).toEqual({ y: 2026, m: 11, d: 12 });
    expect(parseDate('2028-02-29')).not.toBeNull();
    expect(parseDate('2027-02-29')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('nope')).toBeNull();
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-12', 7)).toBe('2026-11-19');
  });

  it('adds months, clamping the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-11-12', 12)).toBe('2027-11-12');
  });

  it('lays out whole weeks starting on Monday', () => {
    const weeks = monthWeeks('2026-11-12'); // 1 Nov 2026 is a Sunday
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]?.[0]?.date).toBe('2026-10-26');
    expect(weeks[0]?.[6]?.date).toBe('2026-11-01');
    expect(weeks[0]?.[6]?.inMonth).toBe(true);
    expect(weeks[0]?.[0]?.inMonth).toBe(false);
    expect(weeks.at(-1)?.at(-1)?.date).toBe('2026-12-06');
    expect(weeks).toHaveLength(6);
  });

  it('uses four weeks for a February that starts on a Monday', () => {
    const weeks = monthWeeks('2027-02-10'); // 1 Feb 2027 is a Monday, 28 days
    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]?.date).toBe('2027-02-01');
    expect(weeks[3]?.[6]?.date).toBe('2027-02-28');
  });

  it('names months and weekdays from Intl, Monday first', () => {
    expect(monthTitle('2026-11-12', 'en-US')).toBe('November 2026');
    expect(weekdayNames('en-US').map((d) => d.long)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    expect(fullDate('2026-11-12', 'en-US')).toBe('Thursday, November 12, 2026');
    expect(monthTitle('2026-11-12', 'de-DE')).toBe('November 2026');
    expect(weekdayNames('de-DE')[0]?.long).toBe('Montag');
  });
});
