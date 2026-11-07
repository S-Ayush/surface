// PLAN-001 S8, the parts of the team handlers that need no database: the client's predicted
// team settings equal the table's defaults; a malformed, reserved or taken key is an error that
// suggests the next free key (SPEC-001 AC-11, E11) without naming the team that has it; and a
// concurrent create's unique violation is recognised.
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { teams } from '../src/db/schema/index.js';
import { isUniqueViolation, keyProblem } from '../src/handlers/teams/shared.js';

describe('NEW_TEAM_SETTINGS', () => {
  it('equals the teams column defaults, so optimistic rows match the server’s', () => {
    const columns = new Map(getTableConfig(teams).columns.map((c) => [c.name, c]));
    for (const [field, value] of Object.entries(NEW_TEAM_SETTINGS)) {
      const column = columns.get(field);
      expect(column, field).toBeDefined();
      // A nullable column without a default starts as null.
      expect(column?.default ?? null, field).toEqual(value);
    }
  });
});

describe('keyProblem (AC-11, E11)', () => {
  it('accepts a free, valid key', () => {
    expect(keyProblem('MP', 'Mobile Platform', new Set(['ENG']))).toBeUndefined();
  });

  it('answers a taken key with CONFLICT and the next free key for the name', () => {
    const error = keyProblem('ENG', 'Engineering', new Set(['ENG', 'ENGI']));
    expect(error?.code).toBe('CONFLICT');
    expect(error?.message).toBe('Team key ENG is taken. Try ENGIN, or choose another.');
    expect(error?.details.issues).toEqual([
      { path: ['key'], message: error?.message, hint: 'e.g. ENGIN' },
    ]);
  });

  it('answers malformed and reserved keys with INVALID_INPUT and a suggestion', () => {
    const malformed = keyProblem('E1', 'Engineering', new Set());
    expect(malformed?.code).toBe('INVALID_INPUT');
    expect(malformed?.message).toBe(
      'Team key must be 2–5 capital letters, like ENG. Try ENG, or choose another.',
    );
    const reserved = keyProblem('API', 'Api platform', new Set(['AP']));
    expect(reserved?.code).toBe('INVALID_INPUT');
    expect(reserved?.message).toBe(
      'API is reserved; choose another team key. Try APL, or choose another.',
    );
  });

  it('never suggests the key it rejects, even when the lookup missed it (a concurrent create)', () => {
    expect(keyProblem('ENG', 'Engineering', new Set(['ENG']))?.message).toContain('Try ENGI');
  });

  it('says how to pick one when the name suggests nothing else', () => {
    const error = keyProblem('OPS', 'Ops', new Set(['OPS']));
    expect(error?.message).toBe(
      'Team key OPS is taken. Choose another: 2–5 capital letters, like ENG.',
    );
    expect(error?.details.issues?.[0]).not.toHaveProperty('hint');
  });
});

describe('isUniqueViolation', () => {
  const pgError = (constraint: string) =>
    Object.assign(new Error('duplicate key'), { code: '23505', constraint });

  it('finds the constraint on the error or a wrapped cause', () => {
    expect(isUniqueViolation(pgError('teams_key_idx'), 'teams_key_idx')).toBe(true);
    const wrapped = new Error('Failed query', { cause: pgError('teams_key_idx') });
    expect(isUniqueViolation(wrapped, 'teams_key_idx')).toBe(true);
  });

  it('ignores other constraints and other errors', () => {
    expect(isUniqueViolation(pgError('teams_pkey'), 'teams_key_idx')).toBe(false);
    expect(isUniqueViolation(new Error('boom'), 'teams_key_idx')).toBe(false);
    expect(isUniqueViolation(undefined, 'teams_key_idx')).toBe(false);
  });
});
