// PLAN-010 S2: the "Add status…" request waits for its page only briefly, and a page that goes
// away without taking it clears it, so a request never opens a form long after the command ran.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADD_STATUS_TTL_MS,
  clearAddStatus,
  requestAddStatus,
  subscribeAddStatus,
  takeAddStatus,
} from '../src/features/statuses/add-intent.js';

afterEach(() => clearAddStatus());

const request = { teamKey: 'ENG', category: 'started' } as const;

describe('add-status request', () => {
  it('is taken once, by its own team', () => {
    requestAddStatus(request, 1_000);
    expect(takeAddStatus('DES', 1_001)).toBeUndefined();
    expect(takeAddStatus('eng', 1_001)).toEqual(request);
    expect(takeAddStatus('ENG', 1_002)).toBeUndefined();
  });

  it('expires if its page does not take it within the window', () => {
    requestAddStatus(request, 1_000);
    expect(takeAddStatus('ENG', 1_000 + ADD_STATUS_TTL_MS + 1)).toBeUndefined();
  });

  it('is still there just inside the window', () => {
    requestAddStatus(request, 1_000);
    expect(takeAddStatus('ENG', 1_000 + ADD_STATUS_TTL_MS)).toEqual(request);
  });

  it('is cleared when the page unmounts without taking it', () => {
    requestAddStatus(request, 1_000);
    clearAddStatus();
    expect(takeAddStatus('ENG', 1_001)).toBeUndefined();
  });

  it('is cleared for its own team only, so leaving another team’s page keeps it', () => {
    requestAddStatus(request, 1_000);
    clearAddStatus('DES');
    expect(takeAddStatus('ENG', 1_001)).toEqual(request);
    requestAddStatus(request, 1_000);
    clearAddStatus('eng');
    expect(takeAddStatus('ENG', 1_001)).toBeUndefined();
  });

  it('tells a mounted page, which takes it', () => {
    const seen: unknown[] = [];
    const stop = subscribeAddStatus(() => seen.push(takeAddStatus('ENG')));
    requestAddStatus(request);
    stop();
    expect(seen).toEqual([request]);
  });
});
