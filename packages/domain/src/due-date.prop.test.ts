// SPEC-012 AC-22: parseDueDate never throws, and what it returns is a real calendar date.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDueDate } from './due-date.js';

const calendarDate = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

function isRealDate(value: string): boolean {
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

const PHRASES = [
  'today',
  'tomorrow',
  'monday',
  'next friday',
  'in 3 days',
  'in 2 weeks',
  'in 5 months',
  'end of week',
  'end of month',
  'dec 3',
  '3 dec',
  'feb 29',
];

describe('parseDueDate (properties)', () => {
  it('never throws on any string, and the result is null or a real YYYY-MM-DD', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), calendarDate, (text, today) => {
        const result = parseDueDate(text, today);
        if (result !== null) expect(isRealDate(result)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), fc.string(), (text, today) => {
        expect(() => parseDueDate(text, today)).not.toThrow();
      }),
    );
  });

  it('gives a real date at or after today for every phrase of the grammar', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PHRASES), calendarDate, (phrase, today) => {
        const result = parseDueDate(phrase, today);
        expect(result).not.toBeNull();
        if (result !== null) {
          expect(isRealDate(result)).toBe(true);
          expect(result >= today).toBe(true);
        }
      }),
    );
  });

  it('puts a weekday name within the next seven days, strictly after today', () => {
    const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    fc.assert(
      fc.property(fc.constantFrom(...names), calendarDate, (name, today) => {
        const result = parseDueDate(name, today);
        expect(result).not.toBeNull();
        if (result === null) return;
        const days = (Date.parse(result) - Date.parse(today)) / 86_400_000;
        expect(days).toBeGreaterThanOrEqual(1);
        expect(days).toBeLessThanOrEqual(7);
      }),
    );
  });

  it('returns an ISO date unchanged', () => {
    fc.assert(
      fc.property(calendarDate, calendarDate, (date, today) => {
        expect(parseDueDate(date, today)).toBe(date);
      }),
    );
  });
});
