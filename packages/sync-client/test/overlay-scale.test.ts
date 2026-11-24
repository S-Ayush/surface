/**
 * The overlay with 1,000 pending mutations (a long offline session): what a rebuild and one more
 * push compute, and how many pending writes a rebuild searches (counted, so linear time is checked
 * without a clock). The frame budget itself (SPEC-002 AC-5, < 16 ms) is in `overlay.perf.test.ts`,
 * which `pnpm test:deep` runs (plans README §6).
 */
import { Issue } from '@surface/domain/model';
import { expect, it } from 'vitest';
import type { OverlayMutation } from '../src/overlay.js';
import { DebugItem, id } from './support/models.js';
import {
  ISSUES,
  PENDING,
  debugScene,
  editTarget,
  issueId,
  issueScene,
} from './support/overlay-scale.js';

it(`rebuilds ${PENDING} pending mutations and pushes one more onto them`, () => {
  const { pool, engine, mutations, next } = debugScene();
  engine.rebuild(mutations);
  engine.push(next);

  expect(pool.count(DebugItem)).toBe(300);
  expect(pool.get(DebugItem, id(1))?.counter).toBe(1 + 5 + 1);
});

// PLAN-011 S8 hardening: it found that each `find` scanned every pending write, so the rebuild
// was quadratic (about 60 ms).
it(`rebuilds ${PENDING} pending issue edits in linear time, with ${ISSUES} issues in the base`, () => {
  const { pool, engine, mutations, next } = issueScene();
  expect(pool.count(Issue)).toBe(ISSUES);

  /** The pending writes the searches of one rebuild of `list` read. */
  const searchedBy = (list: readonly OverlayMutation[]) => {
    const before = engine.searchedWrites;
    engine.rebuild(list);
    return engine.searchedWrites - before;
  };
  const quarter = searchedBy(mutations.slice(0, PENDING / 4));
  const rebuild = searchedBy(mutations);
  engine.push(next);

  expect(pool.count(Issue)).toBe(ISSUES);
  expect(pool.get(Issue, editTarget(998))?.title).toBe('Edit 998');
  expect(pool.get(Issue, editTarget(999))?.priority).toBe(2);
  expect(pool.get(Issue, issueId(ISSUES))?.priority).toBe(1);
  // Linear in the pending edits: each edit's searches read a bounded number of pending writes
  // (its own layer, and the searched model's earlier writes), so four times the edits read at
  // most four times as many. Here that is none: the edits search statuses and labels, which no
  // pending mutation writes. Before the fix each search read every pending write of every model:
  // 999,000 for the 1,000 edits.
  expect(rebuild, `${rebuild} vs ${quarter} for a quarter`).toBeLessThanOrEqual(4 * quarter);
  expect(rebuild).toBeLessThanOrEqual(4 * PENDING);
});
