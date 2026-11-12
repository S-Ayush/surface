// Executor building blocks that need no database: suggestions, ids, retry detection, errors,
// and who may call a `systemOnly` operation (against a connection that answers nothing).
import { systemActor, userActor, type Actor } from '@surface/domain';
import { createRegistry, defineOperation, registry, toOpenApi } from '@surface/operations';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Pool } from '../src/db/pool.js';
import { uuidv7 } from '../src/db/uuidv7.js';
import { handler } from '../src/executor/context.js';
import { ERROR_CODES, HTTP_STATUS } from '../src/executor/errors.js';
import { createExecutor, missingHandlers } from '../src/executor/execute.js';
import { editDistance, nearestNames } from '../src/executor/suggest.js';
import { isRetryable } from '../src/executor/transaction.js';
import { HANDLERS } from '../src/handlers/index.js';
import { ROUTE_ERROR_STATUS } from '../src/http/errors.js';

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
      ['UNAUTHENTICATED', 401],
      ['UNKNOWN_OPERATION', 404],
      ['NOT_FOUND', 404],
      ['FORBIDDEN', 403],
      ['CONFLICT', 409],
      ['RATE_LIMITED', 429],
      ['CLIENT_OUTDATED', 426],
      ['INTERNAL', 500],
    ]);
  });

  it('are all listed with their statuses in the OpenAPI Error response, the routes’ own too', () => {
    const doc = toOpenApi(registry.list(), { version: '0.0.0' });
    const { description } = (doc.components as { responses: { Error: { description: string } } })
      .responses.Error;
    const listed = [...description.matchAll(/\b([A-Z][A-Z_]+) (\d{3})\b/g)].map(
      ([, code, status]) => `${code} ${status}`,
    );
    const answered = [
      ...ERROR_CODES.map((code) => `${code} ${HTTP_STATUS[code]}`),
      ...Object.entries(ROUTE_ERROR_STATUS).map(([code, status]) => `${code} ${status}`),
    ];
    expect(listed.sort()).toEqual(answered.sort());
  });
});

describe('handlers', () => {
  it('exist for every operation in the registry', () => {
    expect(missingHandlers(registry, HANDLERS)).toEqual([]);
  });
});

describe('a systemOnly operation (SPEC-003 §6 step 2)', () => {
  const sweep = defineOperation({
    name: 'issue.sweepFixture',
    kind: 'mutation',
    domain: 'issue',
    summary: 'Sweep issues (fixture)',
    description: 'Test fixture: a job-only operation that does nothing.',
    keywords: ['sweep issues', 'job fixture'],
    input: z.object({}),
    output: z.object({ ran: z.boolean() }),
    permission: () => true,
    destructive: false,
    examples: [{}],
    systemOnly: true,
  });
  // Answers nothing, except the sync client's ledger row: registered to u1, nothing sent yet.
  const client = {
    query: (text: string) =>
      Promise.resolve(
        text.includes('FROM client_mutations WHERE client_id')
          ? { rows: [{ user_id: 'u1', last_seq: '0', stored: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      ),
    release() {},
  };
  // Only `connect`, `query` and `release` are used; pg's overloads are more than a stand-in can match.
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  const executor = (allowInternal: boolean) =>
    createExecutor({
      pool,
      registry: createRegistry([sweep]),
      handlers: [handler(sweep, () => Promise.resolve({ ran: true }))],
      log: pino({ level: 'silent' }),
      allowInternal,
      syncedModels: [],
    });
  const apiKey = { id: 'k1', scope: 'read_write', teamIds: [], allowDestructive: true } as const;
  const admin = { userId: 'u1', role: 'admin', memberships: [] } as const;
  const people: [string, Actor][] = [
    ['user', userActor(admin)],
    ['api', userActor({ ...admin, via: { kind: 'api', apiKey } })],
    ['mcp', userActor({ ...admin, via: { kind: 'mcp', apiKey } })],
  ];

  it.each(people)(
    'is UNKNOWN_OPERATION for a %s actor, in production and outside it',
    async (_, actor) => {
      for (const allowInternal of [false, true]) {
        const run = executor(allowInternal);
        const outcome = await run.execute('issue.sweepFixture', {}, actor);
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: 'UNKNOWN_OPERATION', message: 'Unknown operation "issue.sweepFixture".' },
        });
        // A near miss gets no "Did you mean": the suggestions never name it either.
        const near = await run.execute('issue.sweepFixtur', {}, actor);
        expect(near).toMatchObject({
          ok: false,
          error: { code: 'UNKNOWN_OPERATION', message: 'Unknown operation "issue.sweepFixtur".' },
        });
        expect(run.operations(actor)).toEqual([]);
      }
    },
  );

  it('is rejected as UNKNOWN_OPERATION when a user sends it over sync, in production and outside it', async () => {
    for (const allowInternal of [false, true]) {
      const outcome = await executor(allowInternal).executeSynced(
        'issue.sweepFixture',
        {},
        userActor(admin),
        { clientId: 'c1', seq: 1 },
      );
      // Recorded as the seq's rejected result, so the client's queue moves on (SPEC-002 §4.4).
      expect(outcome).toEqual({
        kind: 'result',
        result: {
          seq: 1,
          status: 'error',
          error: { code: 'UNKNOWN_OPERATION', message: 'Unknown operation "issue.sweepFixture".' },
        },
      });
    }
  });

  it('runs for the system actor, and is never listed, even for it', async () => {
    for (const allowInternal of [false, true]) {
      const outcome = await executor(allowInternal).execute(
        'issue.sweepFixture',
        {},
        systemActor(),
      );
      expect(outcome).toMatchObject({ ok: true, result: { ran: true } });
      expect(executor(allowInternal).operations(systemActor())).toEqual([]);
    }
  });
});
