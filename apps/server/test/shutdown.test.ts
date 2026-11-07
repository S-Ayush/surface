// SPEC-004 §8: drain in-flight requests, run hooks in order, refuse new connections.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/shutdown.js';
import { testApp } from './helpers.js';

async function listening() {
  const t = await testApp();
  const events: string[] = [];
  // Resolves when a request reaches its handler. Shutdown must start only after that: a request
  // that arrives once it has begun gets 503 by design, which a fixed wait raced under load.
  let arrived!: () => void;
  const inHandler = new Promise<void>((resolve) => (arrived = resolve));
  t.app.get('/api/slow', async () => {
    arrived();
    await sleep(300); // keeps the request in flight across the shutdown, on purpose
    events.push('slow request finished');
    return { done: true };
  });
  t.app.get('/api/hang', () => {
    arrived();
    return new Promise(() => {});
  });
  t.lifecycle.onShutdown('connections', 'websockets', () => void events.push('connections hook'));
  t.lifecycle.onShutdown('resources', 'db pool', () => void events.push('resources hook'));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = t.app.server.address() as { port: number };
  t.lifecycle.markReady();
  return { ...t, events, inHandler, base: `http://127.0.0.1:${port}` };
}

describe('gracefulShutdown', () => {
  it('lets in-flight requests finish, then releases resources', async () => {
    const t = await listening();
    const inFlight = fetch(`${t.base}/api/slow`);
    await t.inHandler;

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
    await t.inHandler;

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
