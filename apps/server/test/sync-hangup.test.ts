// PLAN-002 S3 review: a bootstrap holds a pool connection inside an open REPEATABLE READ
// transaction. However early the client hangs up, the server must roll it back and release the
// connection; otherwise a few aborted requests drain the pool and pin VACUUM's horizon.
// The pool is a fake (no Postgres); the HTTP server is real, on 127.0.0.1.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import type { BootstrapClient, BootstrapPool } from '../src/sync/bootstrap.js';
import { DebugItem } from '@surface/domain/model';
import { computeSchemaHash } from '@surface/sync-protocol';
import { debugItems } from '../src/db/schema/index.js';
import { syncModel, type SyncRegistry } from '../src/sync/registry.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

const user = actorFor({ id: randomUUID() });

/** One model, so the fake pool below answers for every query the bootstrap makes. */
const debugOnly: SyncRegistry = (() => {
  const model = syncModel('DebugItem', DebugItem, debugItems);
  return {
    models: [model],
    eager: [model],
    content: [],
    schemaHash: computeSchemaHash([DebugItem]),
  };
})();

/** A pool with one connection. Its row count waits until `openCount()`; it records every call. */
function fakePool() {
  const statements: string[] = [];
  let released = false;
  let openCount = () => {};
  const countGate = new Promise<void>((resolve) => (openCount = resolve));
  let counting = () => {};
  const countStarted = new Promise<void>((resolve) => (counting = resolve));
  let fetched = false;
  const client: BootstrapClient = {
    query: async <R extends Record<string, unknown>>(text: string) => {
      statements.push(text.split(/\s/)[0] ?? '');
      const rows = (values: Record<string, unknown>[]): { rows: R[] } => ({
        rows: values.filter((v): v is R => typeof v === 'object'),
      });
      if (text.startsWith('SELECT last_sync_id')) return rows([{ last: '7' }]);
      if (text.startsWith('SELECT count')) {
        counting();
        await countGate;
        return rows([{ n: '1' }]);
      }
      if (text.startsWith('FETCH') && !fetched) {
        fetched = true;
        return rows([{ id: randomUUID(), title: 't', counter: 0, __groups: ['workspace'] }]);
      }
      return rows([]);
    },
    release: () => {
      released = true;
    },
  };
  const pool: BootstrapPool = { connect: () => Promise.resolve(client) };
  return { pool, statements, released: () => released, openCount, countStarted };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(pool: BootstrapPool) {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: {
      pool,
      registry: debugOnly,
      resolveActor: headerActor({ user }),
    },
  });
  let aborted = () => {};
  const abort = new Promise<void>((resolve) => (aborted = resolve));
  app.addHook('onRequestAbort', (_request, done) => {
    aborted();
    done();
  });
  lifecycle.markReady();
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  close = () => app.close();
  return { url, abort };
}

/** Polls `check` until it holds or 2 s pass, without sleeping. */
async function eventually(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

describe('a client that hangs up', () => {
  it.each([
    ['plain', {}],
    ['gzip', { 'accept-encoding': 'gzip' }],
  ])('while rows are being counted (%s): rolls back and releases', async (_, encoding) => {
    const fake = fakePool();
    const { url, abort } = await serve(fake.pool);
    const request = http.get(`${url}/sync/bootstrap?userId=${user.userId ?? ''}`, {
      headers: { 'x-test-actor': 'user', ...encoding },
    });
    request.on('error', () => {});
    await fake.countStarted;
    request.destroy();
    await abort;
    fake.openCount();

    expect(await eventually(() => fake.released())).toBe(true);
    expect(fake.statements).toContain('ROLLBACK');
    expect(fake.statements).not.toContain('COMMIT');
  });

  it('after the whole stream: commits and releases', async () => {
    const fake = fakePool();
    fake.openCount();
    const { url } = await serve(fake.pool);
    const res = await fetch(`${url}/sync/bootstrap?userId=${user.userId ?? ''}`, {
      headers: { 'x-test-actor': 'user' },
    });
    const lines = (await res.text()).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(['meta', 'row', 'end']);
    expect(await eventually(() => fake.released())).toBe(true);
    expect(fake.statements.at(-1)).toBe('COMMIT');
  });
});
