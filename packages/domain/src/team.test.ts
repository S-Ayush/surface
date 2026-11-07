// PLAN-001 S8: the private-team last-member rule (SPEC-001 E12, D3), and time zone validation
// for teams and users.
import { describe, expect, it } from 'vitest';
import { canEndMembership } from './team.js';
import { canonicalTimeZone, timeZoneProblem } from './workspace.js';

describe('canEndMembership (E12)', () => {
  it('always lets a membership of a public team end, even the last one', () => {
    for (const members of [1, 2, 10])
      expect(canEndMembership({ private: false }, members)).toBe(true);
  });

  it('keeps the last member of a private team', () => {
    expect(canEndMembership({ private: true }, 1)).toBe(false);
    expect(canEndMembership({ private: true }, 2)).toBe(true);
  });
});

describe('timeZoneProblem', () => {
  it('accepts IANA zones in any case', () => {
    for (const zone of [
      'UTC',
      'utc',
      'Europe/Berlin',
      'europe/berlin',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
      'US/Pacific',
    ]) {
      expect(timeZoneProblem(zone)).toBeUndefined();
    }
  });

  it('rejects unknown zones, legacy ids and offsets, saying what to use', () => {
    for (const zone of ['Mars/Olympus', '+05:00', 'PST', 'EST5EDT', 'GMT', 'x'.repeat(65)]) {
      expect(timeZoneProblem(zone)).toMatch(/^".*" is not a time zone\. Use an IANA name/);
    }
  });

  it('asks for a zone when it is empty', () => {
    expect(timeZoneProblem('')).toBe('Time zone is required, like Europe/Berlin');
  });
});

describe('canonicalTimeZone', () => {
  it('stores one spelling per zone', () => {
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('US/Pacific')).toBe('America/Los_Angeles');
  });

  it('leaves what is not a zone alone', () => {
    expect(canonicalTimeZone('Mars/Olympus')).toBe('Mars/Olympus');
  });
});
