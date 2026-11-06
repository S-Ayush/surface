// SPEC-004 §8: drain in-flight requests, run hooks in order, refuse new connections.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/shutdown.js';
import { testApp } from './helpers.js';

async function listening() {
  const t = await testApp();
  const events: string[] = [];
  t.app.get('/api/slow', async () => {
    await sleep(300);
    events.push('slow request finished');
    return { done: true };
  });
  t.app.get('/api/hang', () => new Promise(() => {}));
  t.lifecycle.onShutdown('connections', 'websockets', () => void events.push('connections hook'));
  t.lifecycle.onShutdown('resources', 'db pool', () => void events.push('resources hook'));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = t.app.server.address() as { port: number };
  t.lifecycle.markReady();
  return { ...t, events, base: `http://127.0.0.1:${port}` };
}

describe('gracefulShutdown', () => {
  it('lets in-flight requests finish, then releases resources', async () => {
    const t = await listening();
    const inFlight = fetch(`${t.base}/api/slow`);
    await sleep(50);

    await gracefulShutdown({ app: t.app, lifecycle: t.lifecycle, log: t.app.log as never });

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(t.lifecycle.state).toBe('draining');
    expect(t.events).toEqual(['connections hook', 'slow request finished', 'resources hook']);
    await expect(fetch(`${t.base}/healthz`)).rejects.toThrow();
  });

  it('cuts requests that outlive the drain timeout', async () => {
    const t = await listening();
    const hanging = fetch(`${t.base}/api/hang`).catch((error: unknown) => error);
    await sleep(50);

    const started = performance.now();
    await gracefulShutdown({
      app: t.app,
      lifecycle: t.lifecycle,
      log: t.app.log as never,
      drainTimeoutMs: 200,
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(2_000);
    expect(await hanging).toBeInstanceOf(Error);
    expect(t.events).toEqual(['connections hook', 'resources hook']);
    expect(
      t.logs.lines.some(
        (l) => l.level === 'warn' && String(l.msg).includes('did not finish in time'),
      ),
    ).toBe(true);
  });

  it('keeps shutting down when a hook throws', async () => {
    const t = await listening();
    t.lifecycle.onShutdown('connections', 'broken', () => {
      throw new Error('hook failed');
    });
    await gracefulShutdown({ app: t.app, lifecycle: t.lifecycle, log: t.app.log as never });
    expect(t.events).toEqual(['connections hook', 'resources hook']);
    expect(t.logs.lines.some((l) => l.msg === 'shutdown hook failed' && l.hook === 'broken')).toBe(
      true,
    );
  });
});
