// AC-3: the pipeline order holds (scope → rate limit → validation → resolution → permission →
// handler), and each failure returns its code and HTTP status (SPEC-003 §6, §9, E4, E5, E7, E8).
import { randomUUID } from 'node:crypto';
import type { ApiKeyScope } from '@surface/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '../src/executor/errors.js';
import type { ExecuteResult } from '../src/executor/execute.js';
import type { RateLimiter } from '../src/executor/rate-limit.js';
import {
  actors,
  calls,
  executorHarness,
  outboxFor,
  resetFlaky,
  testExecutor,
  type ExecutorHarness,
} from './executor.js';
import { actorFor } from './helpers.js';

let h: ExecutorHarness;
let who: ReturnType<typeof actors>;
beforeAll(async () => {
  h = await executorHarness();
  who = actors(h.teams);
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  calls.teamNote = 0;
  resetFlaky();
});

const denyAll: RateLimiter = { take: () => ({ allowed: false, retryAfterSeconds: 7 }) };
const readKey: ApiKeyScope = { scope: 'read', teamIds: [], allowDestructive: false };

function failed(result: ExecuteResult) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  return { ...result.error, status: HTTP_STATUS[result.error.code] };
}

describe('1–2: operation lookup', () => {
  it('reports an unknown operation as UNKNOWN_OPERATION (404) and suggests close names', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(await executor.execute('debug.teamNot', {}, who.engMember));
    expect(error).toMatchObject({ code: 'UNKNOWN_OPERATION', status: 404 });
    expect(error.message).toBe('Unknown operation "debug.teamNot". Did you mean debug.teamNote?');
  });

  it('hides internal operations from API actors and from everyone in production', async () => {
    const { executor } = testExecutor(h.pool);
    const api = actorFor({ id: randomUUID() }, { kind: 'api', apiKey: readKey });
    const error = failed(await executor.execute('debug.echo', {}, api));
    expect(error.code).toBe('UNKNOWN_OPERATION');
    expect(error.message).not.toContain('debug.echo?');

    const { executor: production } = testExecutor(h.pool, { allowInternal: false });
    expect(failed(await production.execute('debug.echo', {}, who.engMember)).code).toBe(
      'UNKNOWN_OPERATION',
    );
    const ok = await executor.execute('debug.echo', { text: 'hi' }, who.engMember);
    expect(ok).toEqual({ ok: true, result: { text: 'hi', actorKind: 'user' } });
  });
});

describe('3: key scope', () => {
  it('refuses a mutation for a read-only key (403) before rate limits and validation', async () => {
    const { executor } = testExecutor(h.pool, { rateLimiter: denyAll });
    const api = actorFor({ id: randomUUID() }, { kind: 'api', apiKey: readKey });
    const error = failed(await executor.execute('debug.teamNote', { note: '' }, api));
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403, operation: 'debug.teamNote' });
    expect(error.message).toMatch(/read-only/);
  });
});

describe('4: rate limit', () => {
  it('returns RATE_LIMITED (429) with retryAfter, before validation', async () => {
    const { executor } = testExecutor(h.pool, { rateLimiter: denyAll });
    const error = failed(await executor.execute('debug.teamNote', { note: '' }, who.engMember));
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: 7 });
  });
});

describe('5: input validation', () => {
  it('returns INVALID_INPUT (400) with every issue, before resolving references', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(
      await executor.execute('debug.teamNote', { team: 'NOPE', note: '' }, who.engMember),
    );
    expect(error).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect(error.message).toBe('note: Too small: expected string to have >=1 characters');
    expect(error.issues).toEqual([
      { path: ['note'], message: 'Too small: expected string to have >=1 characters' },
    ]);
  });
});

describe('7: reference resolution', () => {
  it('returns NOT_FOUND (404) before the permission check', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(
      await executor.execute('debug.teamNote', { team: 'NOPE', note: 'x' }, who.outsider),
    );
    expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('reports a private team as NOT_FOUND to a non-member, never FORBIDDEN', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(
      await executor.execute('debug.teamNote', { team: 'SEC', note: 'x' }, who.engMember),
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('hides teams outside an API key’s teams as NOT_FOUND', async () => {
    const { executor } = testExecutor(h.pool);
    const key = actorFor(
      { id: randomUUID(), memberships: [{ teamId: h.teams.eng, private: false }] },
      {
        kind: 'api',
        apiKey: { scope: 'read_write', teamIds: [h.teams.sec], allowDestructive: false },
      },
    );
    expect(
      failed(await executor.execute('debug.teamNote', { team: 'ENG', note: 'x' }, key)).code,
    ).toBe('NOT_FOUND');
  });
});

describe('8: permission', () => {
  it('returns FORBIDDEN (403) with a reason, and never runs the handler', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(
      await executor.execute('debug.teamNote', { team: 'ENG', note: 'x' }, who.outsider),
    );
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Only members of Engineering can add a note to a team.',
    });
    expect(calls.teamNote).toBe(0);
  });

  it('runs the handler with resolved references when allowed', async () => {
    const { executor } = testExecutor(h.pool);
    const result = await executor.execute(
      'debug.teamNote',
      { team: 'eng', note: 'x' },
      who.engMember,
    );
    expect(result).toEqual({ ok: true, result: { team: 'ENG', note: 'x' } });
    expect(calls.teamNote).toBe(1);
  });
});

describe('9–13: handler and result', () => {
  it('passes a handler’s SurfaceError through with its code (409 CONFLICT)', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(
      await executor.execute('debug.explode', { kind: 'conflict' }, who.engMember),
    );
    expect(error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'That name is taken. Pick another one.',
    });
  });

  it('turns an unexpected error into INTERNAL (500) without leaking it, and logs it (E4)', async () => {
    const { executor, logs } = testExecutor(h.pool);
    const result = await executor.execute('debug.explode', { kind: 'bug' }, who.engMember, {
      correlationId: 'req-42',
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        operation: 'debug.explode',
        message: 'Something went wrong. The error has been logged.',
        correlationId: 'req-42',
      },
    });
    const logged = logs.lines.find((l) => l.msg === 'operation failed');
    expect(logged).toMatchObject({ correlationId: 'req-42', op: 'debug.explode' });
    expect(JSON.stringify(logged)).toContain('secret internal detail');
  });

  it('treats output that breaks the operation’s schema as INTERNAL', async () => {
    const { executor } = testExecutor(h.pool);
    expect(
      failed(await executor.execute('debug.explode', { kind: 'badOutput' }, who.engMember)).code,
    ).toBe('INTERNAL');
  });

  it('returns CONFLICT when a client-supplied id already exists (E7)', async () => {
    const { executor } = testExecutor(h.pool);
    const id = randomUUID();
    expect((await executor.execute('debug.createItem', { id, title: 'a' }, who.engMember)).ok).toBe(
      true,
    );
    const error = failed(
      await executor.execute('debug.createItem', { id, title: 'b' }, who.engMember),
    );
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'DebugItem id already exists. Use a new id.',
    });
  });

  it('runs a deprecated operation and names its replacement (E8)', async () => {
    const { executor } = testExecutor(h.pool);
    expect(await executor.execute('debug.oldEcho', {}, who.engMember)).toEqual({
      ok: true,
      result: { ok: true },
      deprecation: { replacedBy: 'debug.echo' },
    });
  });

  it('writes the handler’s events to the outbox with the actor', async () => {
    const { executor } = testExecutor(h.pool);
    const id = randomUUID();
    await executor.execute('debug.createItem', { id, title: 'a' }, who.engMember);
    const touched = await executor.execute('debug.touch', { id }, who.engMember);
    expect(touched).toMatchObject({ ok: true, result: { id, counter: 1 } });
    expect(await outboxFor(h.pool, id)).toEqual([
      {
        type: 'debug.touched',
        actor: { kind: 'user', userId: who.engMember.userId },
        subject: { type: 'debug_item', id },
        changes: { counter: { from: 0, to: 1 } },
      },
    ]);
  });
});

describe('E5: serialization failures and deadlocks', () => {
  it('retries transparently', async () => {
    const { executor } = testExecutor(h.pool);
    expect(await executor.execute('debug.flaky', { failures: 2 }, who.engMember)).toEqual({
      ok: true,
      result: { attempts: 3 },
    });
  });

  it('gives up after 3 retries with CONFLICT, not INTERNAL', async () => {
    const { executor } = testExecutor(h.pool);
    const error = failed(await executor.execute('debug.flaky', { failures: 10 }, who.engMember));
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'This changed at the same time as another update. Try again.',
    });
  });
});

describe('14: logging', () => {
  it('logs one line per call with op, actor kind, duration and outcome', async () => {
    const { executor, logs } = testExecutor(h.pool);
    await executor.execute('debug.echo', {}, who.engMember, { correlationId: 'c-1' });
    await executor.execute('no.such', {}, who.engMember, { correlationId: 'c-2' });
    const lines = logs.lines.filter((l) => l.msg === 'operation');
    expect(lines).toMatchObject([
      { op: 'debug.echo', actorKind: 'user', outcome: 'ok', correlationId: 'c-1' },
      { op: 'unknown', actorKind: 'user', outcome: 'UNKNOWN_OPERATION', correlationId: 'c-2' },
    ]);
    expect(typeof lines[0]?.durationMs).toBe('number');
  });
});
