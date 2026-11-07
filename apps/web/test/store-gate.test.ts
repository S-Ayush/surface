// SPEC-005 §3 "store not ready → shell with a bootstrap progress bar", SPEC-002 §7: the progress
// screen is for the first load only; once the replica has been ready, the page stays through a
// resync, and an outdated store raises the persistent banner instead (SPEC-005 §8).
import { describe, expect, it } from 'vitest';
import { gateView } from '../src/app/gate.js';

describe('store gate', () => {
  it('holds the page back until the first ready', () => {
    expect(gateView('idle', false)).toBe('loading');
    expect(gateView('hydrating', false)).toBe('loading');
    expect(gateView('bootstrapping', false)).toBe('loading');
    expect(gateView('failed', false)).toBe('failed');
    expect(gateView('outdated', false)).toBe('outdated');
    expect(gateView('ready', false)).toBe('page');
  });

  it('keeps the page once the replica has been ready', () => {
    for (const status of [
      'idle',
      'hydrating',
      'bootstrapping',
      'failed',
      'outdated',
      'ready',
    ] as const) {
      expect(gateView(status, true)).toBe('page');
    }
  });
});
