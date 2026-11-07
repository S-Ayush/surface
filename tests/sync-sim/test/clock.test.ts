/**
 * The clock's bookkeeping holds across cases: what one case left behind never
 * stalls the next (review n1).
 */
import { afterEach, expect, it } from 'vitest';
import { installClock, settle, uninstallClock } from '../src/clock.js';

afterEach(() => uninstallClock());

it('settles a new case although an immediate from the last one runs during it', async () => {
  installClock();
  let ran = false;
  setImmediate(() => (ran = true)); // still queued when the case ends
  uninstallClock();
  installClock();
  await expect(settle()).resolves.toBeUndefined();
  expect(ran).toBe(true);
});
