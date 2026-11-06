import { afterEach, expect, it } from 'vitest';
import { testApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
});

it('turns unexpected errors into a generic INTERNAL error and logs the details', async () => {
  t = await testApp();
  t.app.get('/api/boom', () => {
    throw new Error('database password is hunter2');
  });
  const res = await t.app.inject({ url: '/api/boom' });
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({
    ok: false,
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong. The error has been logged.',
      correlationId: res.headers['x-request-id'],
    },
  });
  expect(res.body).not.toContain('hunter2');
  expect(t.logs.lines.some((l) => l.msg === 'request failed' && l.level === 'error')).toBe(true);
});

it('reports client errors as INVALID_REQUEST', async () => {
  t = await testApp();
  t.app.post('/api/echo', (request) => request.body);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{not json',
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
});
