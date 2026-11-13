// PLAN-010 S3: the "Create label…" request waits for its page only briefly, and a page that goes
// away without taking it clears it, so a request never opens a form long after the command ran
// (like `status-add-intent.test.ts`).
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREATE_LABEL_TTL_MS,
  WORKSPACE_SCOPE,
  clearCreateLabel,
  requestCreateLabel,
  subscribeCreateLabel,
  takeCreateLabel,
} from '../src/features/labels/add-intent.js';

afterEach(() => clearCreateLabel());

describe('create-label request', () => {
  it('is taken once, by its own page (a team key in any case, or the workspace)', () => {
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    expect(takeCreateLabel('DES', 1_001)).toBe(false);
    expect(takeCreateLabel(WORKSPACE_SCOPE, 1_001)).toBe(false);
    expect(takeCreateLabel('eng', 1_001)).toBe(true);
    expect(takeCreateLabel('ENG', 1_002)).toBe(false);
    requestCreateLabel({ scope: WORKSPACE_SCOPE }, 1_000);
    expect(takeCreateLabel('ENG', 1_001)).toBe(false);
    expect(takeCreateLabel(WORKSPACE_SCOPE, 1_001)).toBe(true);
  });

  it('expires if its page does not take it within the window', () => {
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    expect(takeCreateLabel('ENG', 1_000 + CREATE_LABEL_TTL_MS + 1)).toBe(false);
  });

  it('is still there just inside the window', () => {
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    expect(takeCreateLabel('ENG', 1_000 + CREATE_LABEL_TTL_MS)).toBe(true);
  });

  it('is cleared when the page unmounts without taking it', () => {
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    clearCreateLabel();
    expect(takeCreateLabel('ENG', 1_001)).toBe(false);
  });

  it('is cleared for its own page only, so leaving another page keeps it', () => {
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    clearCreateLabel('DES');
    clearCreateLabel(WORKSPACE_SCOPE);
    expect(takeCreateLabel('ENG', 1_001)).toBe(true);
    requestCreateLabel({ scope: 'ENG' }, 1_000);
    clearCreateLabel('eng');
    expect(takeCreateLabel('ENG', 1_001)).toBe(false);
  });

  it('tells a mounted page, which takes it', () => {
    const seen: boolean[] = [];
    const stop = subscribeCreateLabel(() => seen.push(takeCreateLabel('ENG')));
    requestCreateLabel({ scope: 'ENG' });
    stop();
    requestCreateLabel({ scope: 'ENG' });
    expect(seen).toEqual([true]);
  });
});
