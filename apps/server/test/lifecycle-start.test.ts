// SPEC-004 §8 (PLAN-014 S4b review): the job queue starts during startup and a `resources`
// shutdown hook stops it. A shutdown that begins while it starts finds nothing to stop, so
// `startUnlessDraining` stops it once it has started.
import { describe, expect, it, vi } from 'vitest';
import { Lifecycle, startUnlessDraining } from '../src/lifecycle.js';

function resource() {
  const stop = vi.fn(() => Promise.resolve());
  return { stop };
}

describe('startUnlessDraining', () => {
  it('returns the started resource while starting up', async () => {
    const lifecycle = new Lifecycle();
    const started = resource();
    await expect(startUnlessDraining(lifecycle, () => Promise.resolve(started))).resolves.toBe(
      started,
    );
    expect(started.stop).not.toHaveBeenCalled();
  });

  it('stops a resource whose start finished after a shutdown began, and returns nothing', async () => {
    const lifecycle = new Lifecycle();
    const started = resource();
    let finish: (value: typeof started) => void = () => undefined;
    const pending = startUnlessDraining(
      lifecycle,
      () =>
        new Promise<typeof started>((resolve) => {
          finish = resolve;
        }),
    );
    // SIGTERM while pg-boss starts: the shutdown hooks run with nothing to stop yet.
    lifecycle.beginDraining();
    finish(started);
    await expect(pending).resolves.toBeUndefined();
    expect(started.stop).toHaveBeenCalledOnce();
  });

  it('starts nothing once a shutdown has begun', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.beginDraining();
    const start = vi.fn(() => Promise.resolve(resource()));
    await expect(startUnlessDraining(lifecycle, start)).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
