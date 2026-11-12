// SPEC-012 AC-22 and §4.1: every form of the due-date grammar. 2026-11-12 is a Thursday.
import { describe, expect, it } from 'vitest';
import { formatDueDate, parseDueDate } from './due-date.js';

const TODAY = '2026-11-12'; // Thursday

describe('parseDueDate', () => {
  it('reads ISO dates and rejects impossible ones', () => {
    expect(parseDueDate('2026-12-03', TODAY)).toBe('2026-12-03');
    expect(parseDueDate(' 2028-02-29 ', TODAY)).toBe('2028-02-29');
    expect(parseDueDate('2027-02-29', TODAY)).toBeNull();
    expect(parseDueDate('2026-13-01', TODAY)).toBeNull();
    expect(parseDueDate('2026-00-10', TODAY)).toBeNull();
  });

  it('reads today and tomorrow, ignoring case and spacing', () => {
    expect(parseDueDate('today', TODAY)).toBe('2026-11-12');
    expect(parseDueDate('  ToMoRRow ', TODAY)).toBe('2026-11-13');
    expect(parseDueDate('tomorrow', '2026-12-31')).toBe('2027-01-01');
  });

  it('reads a weekday as the next one after today, never today', () => {
    expect(parseDueDate('friday', TODAY)).toBe('2026-11-13');
    expect(parseDueDate('fri', TODAY)).toBe('2026-11-13');
    expect(parseDueDate('monday', TODAY)).toBe('2026-11-16');
    expect(parseDueDate('thursday', TODAY)).toBe('2026-11-19');
    expect(parseDueDate('sun', TODAY)).toBe('2026-11-15');
  });

  it('reads "next <weekday>" as that day in next week, weeks starting on Monday', () => {
    expect(parseDueDate('next friday', TODAY)).toBe('2026-11-20');
    expect(parseDueDate('next monday', TODAY)).toBe('2026-11-16');
    expect(parseDueDate('next thursday', TODAY)).toBe('2026-11-19');
    expect(parseDueDate('next sunday', TODAY)).toBe('2026-11-22');
    // On a Sunday, next week starts tomorrow.
    expect(parseDueDate('next monday', '2026-11-15')).toBe('2026-11-16');
    expect(parseDueDate('next friday', '2026-11-15')).toBe('2026-11-20');
    expect(parseDueDate('next someday', TODAY)).toBeNull();
  });

  it('reads "in N days, weeks or months"', () => {
    expect(parseDueDate('in 3 days', TODAY)).toBe('2026-11-15');
    expect(parseDueDate('in 1 day', TODAY)).toBe('2026-11-13');
    expect(parseDueDate('in 2 weeks', TODAY)).toBe('2026-11-26');
    expect(parseDueDate('in 1 month', TODAY)).toBe('2026-12-12');
    expect(parseDueDate('in 3 months', TODAY)).toBe('2027-02-12');
    expect(parseDueDate('in 1 month', '2026-01-31')).toBe('2026-02-28');
    expect(parseDueDate('in 0 days', TODAY)).toBe('2026-11-12');
  });

  it('reads the end of the week (Sunday) and of the month', () => {
    expect(parseDueDate('end of week', TODAY)).toBe('2026-11-15');
    expect(parseDueDate('end of week', '2026-11-15')).toBe('2026-11-15');
    expect(parseDueDate('end of week', '2026-11-16')).toBe('2026-11-22');
    expect(parseDueDate('end of month', TODAY)).toBe('2026-11-30');
    expect(parseDueDate('end of month', '2028-02-10')).toBe('2028-02-29');
  });

  it('reads a month and day in either order, with or without a year', () => {
    expect(parseDueDate('dec 3', TODAY)).toBe('2026-12-03');
    expect(parseDueDate('3 dec', TODAY)).toBe('2026-12-03');
    expect(parseDueDate('December 3rd', TODAY)).toBe('2026-12-03');
    expect(parseDueDate('sept 9', TODAY)).toBe('2027-09-09');
    expect(parseDueDate('dec 3 2027', TODAY)).toBe('2027-12-03');
    expect(parseDueDate('dec 3, 2027', TODAY)).toBe('2027-12-03');
  });

  it('takes a month and day without a year as the next one on or after today', () => {
    expect(parseDueDate('nov 12', TODAY)).toBe('2026-11-12');
    expect(parseDueDate('nov 11', TODAY)).toBe('2027-11-11');
    expect(parseDueDate('jan 1', TODAY)).toBe('2027-01-01');
    expect(parseDueDate('feb 29', TODAY)).toBe('2028-02-29');
  });

  it('returns null for anything else', () => {
    for (const text of [
      '',
      '   ',
      'soon',
      'feb 30',
      'xyz 3',
      'ma 3',
      'in 3 years',
      '32 dec',
      'dec 0',
    ]) {
      expect(parseDueDate(text, TODAY), text).toBeNull();
    }
  });

  it('returns null for a today that is not a calendar date', () => {
    expect(parseDueDate('today', 'yesterday')).toBeNull();
  });
});

describe('formatDueDate', () => {
  it('shows month and day, with the year when it is not the current one', () => {
    expect(formatDueDate('2026-12-03', TODAY)).toBe('Dec 3');
    expect(formatDueDate('2027-01-01', TODAY)).toBe('Jan 1, 2027');
    expect(formatDueDate('2025-12-31', TODAY)).toBe('Dec 31, 2025');
  });

  it('returns a value that is not a date unchanged', () => {
    expect(formatDueDate('later', TODAY)).toBe('later');
  });
});
