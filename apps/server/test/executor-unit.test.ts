// Executor building blocks that need no database: suggestions, ids, retry detection, errors.
import { describe, expect, it } from 'vitest';
import { registry } from '@surface/operations';
import { uuidv7 } from '../src/db/uuidv7.js';
import { ERROR_CODES, HTTP_STATUS } from '../src/executor/errors.js';
import { missingHandlers } from '../src/executor/execute.js';
import { editDistance, nearestNames } from '../src/executor/suggest.js';
import { isRetryable } from '../src/executor/transaction.js';
import { HANDLERS } from '../src/handlers/index.js';

describe('nearestNames', () => {
  const names = ['team.update', 'team.create', 'team.list', 'user.setRole', 'issue.update'];

  it('suggests only close names when there are some', () => {
    expect(nearestNames('team.updte', names)).toEqual(['team.update']);
    expect(nearestNames('Team.Update', names)).toEqual(['team.update']);
  });

  it('falls back to names in the same domain', () => {
    expect(nearestNames('team.rename', names)).toEqual(['team.create', 'team.update', 'team.list']);
  });

  it('suggests nothing for a name unlike any operation', () => {
    expect(nearestNames('completely.different', names)).toEqual([]);
  });

  it('skips the search for absurdly long names', () => {
    expect(nearestNames(`team.${'x'.repeat(10_000)}`, names)).toEqual([]);
  });

  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('uuidv7', () => {
  it('is a version 7, RFC 9562 variant UUID carrying the current time', () => {
    const before = Date.now();
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('keeps creation order for ids made in the same millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isRetryable (E5)', () => {
  it('retries serialization failures and deadlocks, also when wrapped', () => {
    expect(isRetryable(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    expect(isRetryable(new Error('wrapped', { cause: { code: '40P01' } }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isRetryable('40001')).toBe(false);
  });
});

describe('error codes', () => {
  it('map to the SPEC-003 §9 HTTP statuses', () => {
    expect(ERROR_CODES.map((code) => [code, HTTP_STATUS[code]])).toEqual([
      ['INVALID_INPUT', 400],
      ['UNKNOWN_OPERATION', 404],
      ['NOT_FOUND', 404],
      ['FORBIDDEN', 403],
      ['CONFLICT', 409],
      ['RATE_LIMITED', 429],
      ['CLIENT_OUTDATED', 426],
      ['INTERNAL', 500],
    ]);
  });
});

describe('handlers', () => {
  it('exist for every operation in the registry', () => {
    expect(missingHandlers(registry, HANDLERS)).toEqual([]);
  });
});
