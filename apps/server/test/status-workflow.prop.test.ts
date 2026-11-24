// PLAN-010 S2, SPEC-010 AC-4 (property): for any sequence of status operations, refused ones
// included, and default changes, the committed workflow satisfies INV-04 and INV-05
// (`workflowProblems` is empty), a refused operation changes nothing, and every category's keys
// stay a strict total order in byte order with no duplicates (AC-3). The operations, including
// `team.setDefaultStatus` (S4), run through the same rules the handlers use, on an in-memory
// workflow.
import { randomUUID } from 'node:crypto';
import { EDITABLE_STATUS_CATEGORIES, workflowProblems, type StatusCategory } from '@surface/domain';
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createStatus,
  deleteStatus,
  reorderStatus,
  setDefaultStatus,
  updateStatus,
} from '../src/handlers/statuses/core.js';
import { memoryWorkflow, type MemoryWorkflow } from './support/memory-workflow.js';

type Step =
  | { kind: 'create'; category: StatusCategory; name: number; after: number | null }
  | { kind: 'update'; target: number; name: number | null; color: boolean }
  | { kind: 'reorder'; target: number; anchor: number; side: 'before' | 'after' }
  | { kind: 'delete'; target: number }
  | { kind: 'default'; target: number };

const index = fc.nat({ max: 60 });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      category: fc.constantFrom<StatusCategory>(...EDITABLE_STATUS_CATEGORIES),
      // A small name space makes clashes likely.
      name: fc.nat({ max: 12 }),
      after: fc.option(index, { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('update' as const),
      target: index,
      name: fc.option(fc.nat({ max: 12 }), { nil: null }),
      color: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('reorder' as const),
      target: index,
      anchor: index,
      side: fc.constantFrom('before' as const, 'after' as const),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('delete' as const), target: index }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('default' as const), target: index }) },
);

function pick(w: MemoryWorkflow, n: number): string {
  const rows = [...w.rows.values()];
  const row = rows[n % rows.length];
  if (!row) throw new Error('empty workflow');
  return row.id;
}

/** Runs one step; returns whether it committed. */
async function run(w: MemoryWorkflow, s: Step): Promise<boolean> {
  const scope = { teamRef: 'ENG', team: { id: w.team.id, key: w.team.key } };
  try {
    switch (s.kind) {
      case 'create':
        await createStatus(w.access, w.repo, {
          id: randomUUID(),
          ...scope,
          name: `S${s.name}`,
          category: s.category,
          after: s.after === null ? undefined : pick(w, s.after),
        });
        return true;
      case 'update':
        await updateStatus(w.access, w.repo, {
          ...scope,
          statusId: pick(w, s.target),
          name: s.name === null ? undefined : `S${s.name}`,
          color: s.color ? 'red' : undefined,
        });
        return true;
      case 'reorder':
        await reorderStatus(w.access, w.repo, {
          ...scope,
          statusId: pick(w, s.target),
          [s.side]: pick(w, s.anchor),
        });
        return true;
      case 'delete':
        await deleteStatus(w.access, w.repo, { ...scope, statusId: pick(w, s.target) });
        return true;
      case 'default':
        // The real rule (PLAN-010 S4), refusals included: any status can be the target, and
        // the property covers deletes of the default (E17).
        await setDefaultStatus(w.access, w.repo, { ...scope, statusId: pick(w, s.target) });
        return true;
    }
  } catch (error) {
    if (error instanceof SurfaceError) return false;
    throw error;
  }
}

describe('any sequence of status operations (AC-4, AC-3)', () => {
  it('keeps INV-04 and INV-05, keys strictly ordered, and a refused step changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 60 }), async (steps) => {
        const w = memoryWorkflow();
        for (const s of steps) {
          const before = w.snapshot();
          const committed = await run(w, s);
          if (!committed) expect(w.snapshot()).toBe(before);
          expect(workflowProblems([...w.rows.values()], w.team.defaultStatusId)).toEqual([]);
          for (const category of new Set([...w.rows.values()].map((r) => r.category))) {
            const keys = [...w.rows.values()]
              .filter((r) => r.category === category)
              .map((r) => r.position);
            expect(new Set(keys).size).toBe(keys.length);
          }
          const names = [...w.rows.values()].map((r) => r.name.toLowerCase());
          expect(new Set(names).size).toBe(names.length);
        }
      }),
      propertyParameters({ numRuns: 300 }),
    );
  });
});
