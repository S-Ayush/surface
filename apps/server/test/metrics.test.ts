import { afterEach, expect, it } from 'vitest';
import { testApp, type TestApp } from './helpers.js';

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
