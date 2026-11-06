// SPEC-003 §9: operations over HTTP. AC-1 (one definition, every surface, no glue), AC-8 over
// HTTP, status mapping, 401/503, rate limiting with Retry-After, and the actor-filtered catalog.
import { randomUUID } from 'node:crypto';
import { createRegistry, ALL_OPERATIONS } from '@surface/operations';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { tokenBucket } from '../src/executor/rate-limit.js';
import { createLogger } from '../src/logger.js';
import { Lifecycle } from '../src/lifecycle.js';
import {
  actors,
  executorHarness,
  seedDebugItem,
  TEST_OPERATIONS,
  testExecutor,
  type ExecutorHarness,
} from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let app: FastifyInstance;
let lifecycle: Lifecycle;

const registry = () => createRegistry([...ALL_OPERATIONS, ...TEST_OPERATIONS]);

async function appFor(options: { allowInternal?: boolean; mutationsPerMinute?: number } = {}) {
  const who = actors(h.teams);
  const readKey = actorFor(
    { id: randomUUID(), memberships: [{ teamId: h.teams.eng, private: false }] },
    {
      kind: 'api',
      apiKey: { id: randomUUID(), scope: 'read', teamIds: [], allowDestructive: false },
    },
  );
  const writeKey = actorFor(
    { id: randomUUID(), memberships: [{ teamId: h.teams.eng, private: false }] },
    {
      kind: 'api',
      apiKey: { id: randomUUID(), scope: 'read_write', teamIds: [], allowDestructive: false },
    },
  );
  const life = new Lifecycle();
  const config = testConfig({ logLevel: 'info' });
  const built = await buildApp({
    config,
    lifecycle: life,
    logger: createLogger(config, captureLogs().stream),
    info: { version: '9.9.9', commit: 'test' },
    ops: {
      registry: registry(),
      resolveActor: headerActor({ ...who, readKey, writeKey }),
      createExecutor: () =>
        testExecutor(h.pool, {
          allowInternal: options.allowInternal ?? true,
          rateLimiter: tokenBucket({
            queriesPerMinute: 600,
            mutationsPerMinute: options.mutationsPerMinute ?? 120,
          }),
        }).executor,
    },
  });
  return { app: built, lifecycle: life };
}

beforeAll(async () => {
  h = await executorHarness();
  ({ app, lifecycle } = await appFor());
  lifecycle.markReady();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const post = (name: string, body: unknown, actor = 'engMember', target = app) =>
  target.inject({
    method: 'POST',
    url: `/api/ops/${name}`,
    headers: { 'x-test-actor': actor },
    payload: body as object,
  });

describe('AC-1: one definition, every surface', () => {
  it('runs, lists and documents debug.teamNote with no per-operation code', async () => {
    const run = await post('debug.teamNote', { input: { team: 'ENG', note: 'hi' } });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toEqual({ ok: true, result: { team: 'ENG', note: 'hi' } });

    const catalog = await app.inject({ url: '/api/ops', headers: { 'x-test-actor': 'engMember' } });
    const entry = catalog
      .json<{ result: { operations: { name: string }[] } }>()
      .result.operations.find((op) => op.name === 'debug.teamNote');
    expect(entry).toMatchObject({
      name: 'debug.teamNote',
      kind: 'mutation',
      input: { team: { type: 'TeamRef', required: true }, note: { type: 'string' } },
      examples: [{ team: 'ENG', note: 'hi' }],
    });

    const openApi = await app.inject({ url: '/api/openapi.json' });
    expect(openApi.statusCode).toBe(200);
    const paths = Object.keys(openApi.json<{ paths: object }>().paths);
    expect(paths).toContain('/api/ops/debug.teamNote');
    // Internal operations are never published.
    expect(paths).not.toContain('/api/ops/debug.echo');
  });
});

describe('POST /api/ops/:name', () => {
  it('maps operation errors to SPEC-003 statuses with the error body', async () => {
    const unknown = await post('debug.nope', { input: {} });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_OPERATION', correlationId: unknown.headers['x-request-id'] },
    });

    const invalid = await post('debug.teamNote', { input: { team: 'ENG', note: '' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', issues: [{ path: ['note'] }] },
    });

    const forbidden = await post(
      'debug.teamNote',
      { input: { team: 'ENG', note: 'x' } },
      'outsider',
    );
    expect(forbidden.statusCode).toBe(403);

    const hidden = await post('debug.teamNote', { input: { team: 'SEC', note: 'x' } });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('rejects a body that is not { input, fields?, clientMutationId? }', async () => {
    const res = await post('debug.echo', { input: {}, extra: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('projects fields', async () => {
    const res = await post('debug.echo', { input: { text: 'x' }, fields: ['text'] });
    expect(res.json()).toEqual({ ok: true, result: { text: 'x' } });
  });

  it('replays a clientMutationId with the identical body and says so in a header (AC-8)', async () => {
    const id = await seedDebugItem(h.pool);
    const body = { input: { id }, clientMutationId: randomUUID() };
    const first = await post('debug.touch', body);
    const second = await post('debug.touch', body);
    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('answers 401 without a signed-in actor, and 503 while starting', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/api/ops/debug.echo', payload: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });

    const starting = await appFor();
    const res = await post('debug.echo', { input: {} }, 'engMember', starting.app);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    await starting.app.close();
  });

  it('rate-limits with 429 and Retry-After', async () => {
    const limited = await appFor({ mutationsPerMinute: 2 });
    limited.lifecycle.markReady();
    // A public mutation: internal ones don't exist for API keys.
    const note = () =>
      post('debug.teamNote', { input: { team: 'ENG', note: 'x' } }, 'writeKey', limited.app);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await note()).statusCode);
    expect(statuses).toEqual([200, 200, 429]);
    const res = await note();
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: 30 } });
    await limited.app.close();
  });
});

describe('GET /api/ops', () => {
  const names = async (actor: string, target = app) =>
    (await target.inject({ url: '/api/ops', headers: { 'x-test-actor': actor } }))
      .json<{ result: { operations: { name: string }[] } }>()
      .result.operations.map((op) => op.name);

  it('lists what the caller may run: no internal ops for keys, queries only for read keys', async () => {
    expect(await names('engMember')).toContain('debug.echo');
    const readKey = await names('readKey');
    expect(readKey).not.toContain('debug.echo');
    expect(readKey).not.toContain('debug.teamNote');
    expect(readKey).toContain('debug.oldEcho');
    expect(await names('writeKey')).toContain('debug.teamNote');
  });

  it('hides internal operations where they are not allowed', async () => {
    const production = await appFor({ allowInternal: false });
    production.lifecycle.markReady();
    expect(await names('engMember', production.app)).not.toContain('debug.echo');
    await production.app.close();
  });

  it('needs a signed-in actor', async () => {
    expect((await app.inject({ url: '/api/ops' })).statusCode).toBe(401);
  });
});
