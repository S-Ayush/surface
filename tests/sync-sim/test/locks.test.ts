/**
 * The simulated Web Locks and tab timers behave like the browser's, crash
 * included: a dead tab's locks are released and it never gets another.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advance, installClock, settle, uninstallClock } from '../src/clock.js';
import { BrowserLocks } from '../src/locks.js';
import { TabTimers } from '../src/timers.js';

/** Hold `name` in `tab` until the returned function is called. */
function hold(locks: BrowserLocks, tab: string, name: string, mode: 'shared' | 'exclusive') {
  const state = { granted: false, release: () => undefined as void };
  const done = new Promise<void>((resolve) => (state.release = resolve));
  void locks.forTab(tab).request(name, { mode }, () => {
    state.granted = true;
    return done;
  });
  return state;
}

describe('BrowserLocks', () => {
  it('grants shared locks together and an exclusive one alone, in request order', async () => {
    const locks = new BrowserLocks();
    const a = hold(locks, 'a', 'x', 'shared');
    const b = hold(locks, 'b', 'x', 'shared');
    const c = hold(locks, 'c', 'x', 'exclusive');
    const d = hold(locks, 'd', 'x', 'shared');
    await Promise.resolve();
    expect([a.granted, b.granted, c.granted, d.granted]).toEqual([true, true, false, false]);
    a.release();
    b.release();
    await settle();
    expect([c.granted, d.granted]).toEqual([true, false]);
    c.release();
    await settle();
    expect(d.granted).toBe(true);
  });

  it('answers `ifAvailable` with null while the lock is taken', async () => {
    const locks = new BrowserLocks();
    hold(locks, 'a', 'x', 'exclusive');
    const got = await locks
      .forTab('b')
      .request('x', { mode: 'exclusive', ifAvailable: true }, (lock) => Promise.resolve(lock));
    expect(got).toBeNull();
  });

  it('releases a crashed tab’s locks, drops its requests, and never grants it another', async () => {
    const locks = new BrowserLocks();
    hold(locks, 'a', 'x', 'exclusive');
    const c = hold(locks, 'c', 'y', 'exclusive');
    const queued = hold(locks, 'a', 'y', 'exclusive');
    const b = hold(locks, 'b', 'x', 'exclusive');
    locks.forTab('a').kill();
    await settle();
    expect(b.granted).toBe(true);
    expect(locks.held.map((h) => h.tab).sort()).toEqual(['b', 'c']);
    const late = hold(locks, 'a', 'z', 'exclusive');
    await settle();
    expect(late.granted).toBe(false);
    c.release();
    await settle();
    expect(queued.granted).toBe(false);
  });
});

describe('TabTimers', () => {
  beforeEach(() => installClock());
  afterEach(() => uninstallClock());

  it('runs timers until the tab is killed, then none', async () => {
    const timers = new TabTimers();
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('before'), 10);
    timers.setTimeout(() => fired.push('after'), 100);
    await advance(50);
    timers.kill();
    timers.setTimeout(() => fired.push('new'), 1);
    await advance(1_000);
    expect(fired).toEqual(['before']);
  });
});
