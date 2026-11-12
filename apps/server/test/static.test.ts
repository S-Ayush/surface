import { afterEach, describe, expect, it } from 'vitest';
import { fakeWebDir, testApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
});

const html = { accept: 'text/html,application/xhtml+xml' };

describe('web app serving', () => {
  it('caches hashed assets forever and index.html never', async () => {
    t = await testApp({ webDir: fakeWebDir() });

    const asset = await t.app.inject({ url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const root = await t.app.inject({ url: '/', headers: html });
    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.body).toContain('<title>Surface</title>');

    const favicon = await t.app.inject({ url: '/favicon.svg' });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['cache-control']).not.toContain('immutable');
  });

  it('serves the offline worker /sw.js as JavaScript, no-cache, never with the assets’ year-long policy (ADR-0019)', async () => {
    t = await testApp({ webDir: fakeWebDir() });
    for (const method of ['GET', 'HEAD'] as const) {
      const worker = await t.app.inject({ method, url: '/sw.js' });
      expect(worker.statusCode).toBe(200);
      expect(worker.headers['cache-control']).toBe('no-cache');
      // Browsers refuse to register a worker served with any other type.
      expect(worker.headers['content-type']).toMatch(/^(text|application)\/javascript/);
    }
  });

  it('answers client-side routes with the app shell', async () => {
    t = await testApp({ webDir: fakeWebDir() });
    const res = await t.app.inject({ url: '/team/ENG/issues?view=board', headers: html });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<title>Surface</title>');
  });

  it.each([
    ['/api/nope', html],
    ['/sync/nope', html],
    ['/auth/nope', html],
    ['/mcp', html],
    ['/assets/old-999.js', html],
    ['/team/ENG', { accept: 'application/json' }],
  ])('returns a JSON 404 for %s', async (url, headers) => {
    t = await testApp({ webDir: fakeWebDir() });
    const res = await t.app.inject({ url, headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', correlationId: res.headers['x-request-id'] },
    });
  });

  it('serves the API alone when the web app is not built', async () => {
    t = await testApp({ webDir: '/definitely/not/here' });
    expect((await t.app.inject({ url: '/', headers: html })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect(
      t.logs.lines.some((l) => l.level === 'warn' && String(l.msg).startsWith('web app not built')),
    ).toBe(true);
  });
});
