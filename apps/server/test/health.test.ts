// SPEC-004 AC-9: /readyz is 503 while starting (migrations) and draining, 200 when ready;
// /healthz stays 200 while the process is alive.
import { afterEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
});

async function probe(url: string) {
  const res = await t.app.inject({ method: 'GET', url });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown>>(),
    headers: res.headers,
  };
}

describe('health and readiness', () => {
  it('moves through starting → ready → draining', async () => {
    t = await testApp();

    expect(await probe('/readyz')).toMatchObject({
      status: 503,
      body: { status: 'starting', version: '1.2.3' },
    });
    expect(await probe('/healthz')).toMatchObject({ status: 200, body: { status: 'ok' } });

    t.lifecycle.markReady();
    expect(await probe('/readyz')).toMatchObject({
      status: 200,
      body: { status: 'ready', version: '1.2.3' },
    });

    t.lifecycle.beginDraining();
    expect(await probe('/readyz')).toMatchObject({ status: 503, body: { status: 'draining' } });
    expect(await probe('/healthz')).toMatchObject({ status: 200 });
  });

  it('reports each readiness check and is 503 when one fails', async () => {
    t = await testApp();
    t.lifecycle.addReadinessCheck('db', () => Promise.resolve('ok'));
    t.lifecycle.addReadinessCheck('migrations', () => Promise.resolve('current'));
    t.lifecycle.markReady();
    expect(await probe('/readyz')).toMatchObject({
      status: 200,
      body: { status: 'ready', db: 'ok', migrations: 'current' },
    });

    t.lifecycle.addReadinessCheck('db', () => Promise.reject(new Error('connection refused')));
    const res = await probe('/readyz');
    expect(res).toMatchObject({
      status: 503,
      body: { status: 'unavailable', db: 'failing', migrations: 'current' },
    });
    // Internal error details are not exposed on the public endpoint.
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });

  it('is never cached', async () => {
    t = await testApp();
    expect((await probe('/healthz')).headers['cache-control']).toBe('no-store');
    expect((await probe('/readyz')).headers['cache-control']).toBe('no-store');
  });

  it('does not log successful probes', async () => {
    t = await testApp();
    t.lifecycle.markReady();
    await probe('/healthz');
    await probe('/readyz');
    expect(t.logs.lines.filter((l) => l.msg === 'incoming request')).toHaveLength(0);
  });
});

describe('request ids', () => {
  it('echoes a safe X-Request-Id and replaces an unsafe one', async () => {
    t = await testApp();
    const safe = await t.app.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'proxy-abc.123' },
    });
    expect(safe.headers['x-request-id']).toBe('proxy-abc.123');

    const unsafe = await t.app.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'bad id\n{"level":"fatal"}' },
    });
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
