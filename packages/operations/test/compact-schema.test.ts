// AC-10: compact schemas for all M0 operations stay under 400 tokens each (SPEC-003 §10, §13).
import { describe, expect, it } from 'vitest';
import { estimateTokens, registry, toCompactSchema, type AnyOperation } from '../src/index.js';
import { teamList, teamUpdate } from './fixtures.js';

const TOKEN_BUDGET = 400;

function compactTokens(op: AnyOperation): number {
  return estimateTokens(JSON.stringify(toCompactSchema(op.input)));
}

describe('compact schema token budget (AC-10)', () => {
  // The registry grows slice by slice; this test covers each new operation automatically.
  it.each(registry.list().map((op) => [op.name, op] as const))(
    '%s has a compact input schema under 400 tokens',
    (_name, op) => {
      expect(compactTokens(op)).toBeLessThan(TOKEN_BUDGET);
    },
  );

  // Representative shapes until the M0 operations exist (team.update from SPEC-003 §3, and a §7.1 list).
  it.each([teamUpdate, teamList].map((op) => [op.name, op] as const))(
    'the %s fixture has a compact input schema under 400 tokens',
    (_name, op) => {
      expect(compactTokens(op)).toBeLessThan(TOKEN_BUDGET);
    },
  );

  it('estimates conservatively: at least one token per 3 characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
  });
});
