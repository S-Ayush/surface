import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { registerFileMetrics } from '../src/http/metrics.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { captureLogs, testApp, testConfig, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
});

it('exposes Prometheus metrics labelled by route pattern when enabled', async () => {
  t = await testApp({ metricsEnabled: true });
  t.app.get('/api/things/:id', () => ({ ok: true }));
  await t.app.inject({ url: '/api/things/42' });
  await t.app.inject({ url: '/api/things/43' });

  const res = await t.app.inject({ url: '/metrics' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/plain/);
  expect(res.body).toContain(
    'surface_http_request_duration_seconds_count{method="GET",route="/api/things/:id",status_code="200"} 2',
  );
  expect(res.body).toContain('surface_process_cpu_user_seconds_total');
  expect(res.body).not.toContain('/api/things/42');
});

it('has no /metrics route when disabled', async () => {
  t = await testApp({ metricsEnabled: false });
  expect((await t.app.inject({ url: '/metrics' })).statusCode).toBe(404);
});

describe('file metrics (SPEC-014 §10, PLAN-014 S3)', () => {
  const quiet = { warn: () => undefined };

  it('reports stored bytes and the blob_release backlog on each scrape', async () => {
    t = await testApp({ metricsEnabled: false });
    const registry = new Registry();
    let stats = { storedBytes: 3_000_000_000, releaseBacklog: 2 };
    registerFileMetrics(registry, () => Promise.resolve(stats), quiet);
    let text = await registry.metrics();
    expect(text).toContain('surface_files_stored_bytes 3000000000');
    expect(text).toContain('surface_files_blob_release_backlog 2');
    stats = { storedBytes: 10, releaseBacklog: 0 };
    text = await registry.metrics();
    expect(text).toContain('surface_files_stored_bytes 10');
    expect(text).toContain('surface_files_blob_release_backlog 0');
  });

  it('keeps the last values and warns when the database can’t be read, without failing the scrape', async () => {
    t = await testApp({ metricsEnabled: false });
    const registry = new Registry();
    const warnings: string[] = [];
    let fail = false;
    registerFileMetrics(
      registry,
      () =>
        fail
          ? Promise.reject(new Error('database is down'))
          : Promise.resolve({ storedBytes: 5, releaseBacklog: 1 }),
      { warn: (_object: object, message: string) => void warnings.push(message) },
    );
    await registry.metrics();
    fail = true;
    const text = await registry.metrics();
    expect(text).toContain('surface_files_stored_bytes 5');
    expect(warnings).toEqual(['file metrics unavailable', 'file metrics unavailable']);
  });

  it('is served on /metrics when the app is given the file stats', async () => {
    const config = testConfig({ metricsEnabled: true });
    const app = await buildApp({
      config,
      lifecycle: new Lifecycle(),
      logger: createLogger(config, captureLogs().stream),
      info: { version: '1.2.3', commit: 'test' },
      fileStats: () => Promise.resolve({ storedBytes: 42, releaseBacklog: 3 }),
    });
    t = { app, lifecycle: new Lifecycle(), logs: captureLogs() };
    const body = (await app.inject({ url: '/metrics' })).body;
    expect(body).toContain('surface_files_stored_bytes 42');
    expect(body).toContain('surface_files_blob_release_backlog 3');
  });
});
