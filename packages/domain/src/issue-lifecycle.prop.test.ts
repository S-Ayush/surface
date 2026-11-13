// PLAN-015 S1, SPEC-015 AC-1 (property part) and AC-3: over any sequence of lifecycle and edit
// operations, at any times, `lifecycleStep` agrees with an independent model of §4.2: the issue
// is in exactly one state, repeats change nothing, nothing but restore leaves Deleted or
// Archived, delete keeps `archivedAt`, and the 30-day boundary is exact to the millisecond.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_ACTIONS,
  lifecycleOf,
  lifecycleStep,
  RETENTION_HOURS,
  type LifecycleAction,
  type LifecycleStamps,
  type LifecycleStep,
} from './issue-lifecycle.js';

const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

/** Time steps that hit the boundary exactly, just before and after it, and anywhere else. */
const advance = fc.oneof(
  fc.constantFrom(0, 1, RETENTION_MS - 1, RETENTION_MS, RETENTION_MS + 1),
  fc.integer({ min: 0, max: 3 * RETENTION_MS }),
);

const step = fc.record({ action: fc.constantFrom(...LIFECYCLE_ACTIONS), advance });

/** The reference model: the state as an enum, with the times kept as plain numbers. */
interface Model {
  state: 'live' | 'archived' | 'deleted' | 'purged';
  archivedAt: number | null;
  deletedAt: number | null;
}

function modelStep(model: Model, action: LifecycleAction, now: number): string {
  if (model.state === 'purged') return 'gone';
  switch (action) {
    case 'cascade':
      return 'applies';
    case 'edit':
      return model.state === 'live' ? 'applies' : `conflict:${model.state}`;
    case 'autoArchive':
      if (model.state !== 'live') return 'skipped';
      model.state = 'archived';
      model.archivedAt = now;
      return 'moves';
    case 'delete':
      if (model.state === 'deleted') return 'noop';
      model.state = 'deleted';
      model.deletedAt = now;
      return 'moves';
    case 'restore':
      if (model.state === 'live') return 'noop';
      if (model.state === 'deleted' && now - (model.deletedAt ?? 0) >= RETENTION_MS) {
        return 'conflict:expired';
      }
      model.state = 'live';
      model.archivedAt = null;
      model.deletedAt = null;
      return 'moves';
    case 'purge':
      if (model.state !== 'deleted') return 'conflict:notDeleted';
      model.state = 'purged';
      return 'purged';
  }
}

describe('lifecycleStep over operation sequences (AC-1, AC-3)', () => {
  it('agrees with the §4.2 model at every step, the 720 h boundary included', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        let issue: LifecycleStamps<Date> | undefined = { archivedAt: null, deletedAt: null };
        const model: Model = { state: 'live', archivedAt: null, deletedAt: null };
        for (const { action, advance: ms } of steps) {
          now += ms;
          const expected = modelStep(model, action, now);
          if (issue === undefined) {
            expect(expected).toBe('gone');
            continue;
          }
          const current: LifecycleStamps<Date> = issue;
          const result: LifecycleStep<Date> = lifecycleStep(
            action,
            current,
            new Date(now),
            new Date(now),
          );
          const got =
            result.kind === 'conflict' ? `conflict:${result.conflict}` : String(result.kind);
          expect(got).toBe(expected);
          if (result.kind === 'purged') {
            issue = undefined;
            continue;
          }
          // Delete keeps archivedAt; restore clears both; archive sets only archivedAt.
          const next = result.kind === 'moves' ? result.stamps : current;
          if (result.kind === 'moves') expect(lifecycleOf(next)).toBe(result.to);
          issue = next;
          // Exactly one state, and the same one as the model's.
          expect(lifecycleOf(next)).toBe(model.state);
          expect({
            archivedAt: next.archivedAt?.getTime() ?? null,
            deletedAt: next.deletedAt?.getTime() ?? null,
          }).toEqual({ archivedAt: model.archivedAt, deletedAt: model.deletedAt });
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('changes nothing when delete or restore is repeated at once', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 20 }), (steps) => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        let issue: LifecycleStamps<Date> = { archivedAt: null, deletedAt: null };
        for (const { action, advance: ms } of steps) {
          now += ms;
          if (action === 'purge') continue;
          const first = lifecycleStep(action, issue, new Date(now), new Date(now));
          if (first.kind !== 'moves') continue;
          issue = first.stamps;
          if (action !== 'delete' && action !== 'restore') continue;
          expect(lifecycleStep(action, issue, new Date(now), new Date(now))).toEqual({
            kind: 'noop',
          });
        }
      }),
    );
  });
});
