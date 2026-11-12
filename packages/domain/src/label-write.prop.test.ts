// PLAN-010 S1, SPEC-010 AC-10 (property part): for any labels, groups and issue labels, the
// label-write rule `applyLabelAdd` never leaves two labels of an exclusive group that the write
// added to, keeps multi-select groups and untouched groups as they were, and never invents or
// duplicates an id. PLAN-010 S5 extends this with the real issue shapes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyLabelAdd, type LabelInfo } from './label.js';

interface Universe {
  readonly labels: ReadonlyMap<string, LabelInfo>;
  readonly ids: readonly string[];
}

/** Groups (single- or multi-select) with labels in them, plus labels in no group. */
const universe: fc.Arbitrary<Universe> = fc
  .record({
    groups: fc.array(fc.record({ exclusive: fc.boolean(), size: fc.nat({ max: 4 }) }), {
      maxLength: 3,
    }),
    loose: fc.nat({ max: 4 }),
  })
  .map(({ groups, loose }) => {
    const labels = new Map<string, LabelInfo>();
    groups.forEach((g, i) => {
      labels.set(`g${i}`, { parentId: null, exclusive: g.exclusive });
      for (let j = 0; j < g.size; j++) {
        labels.set(`g${i}l${j}`, { parentId: `g${i}`, exclusive: true });
      }
    });
    for (let j = 0; j < loose; j++) labels.set(`l${j}`, { parentId: null, exclusive: true });
    // Applied labels are never groups (INV-07); `gone` stands for a deleted label's id.
    const ids = [...labels.keys()].filter((id) => !/^g\d+$/.test(id)).concat('gone');
    return { labels, ids };
  });

const scenario = universe.chain((u) =>
  fc.record({
    u: fc.constant(u),
    current: fc.array(fc.constantFrom(...u.ids), { maxLength: 8 }),
    added: fc.array(fc.constantFrom(...u.ids), { maxLength: 6 }),
  }),
);

function exclusiveGroup(labels: ReadonlyMap<string, LabelInfo>, id: string): string | undefined {
  const parentId = labels.get(id)?.parentId;
  if (parentId == null) return undefined;
  return labels.get(parentId)?.exclusive ? parentId : undefined;
}

describe('applyLabelAdd (AC-10 property)', () => {
  it('enforces one label per exclusive group only for the groups a write adds to', () => {
    fc.assert(
      fc.property(scenario, ({ u, current, added }) => {
        const result = applyLabelAdd(u.labels, current, added);

        // No duplicates, and nothing that wasn't on the issue or added.
        expect(new Set(result).size).toBe(result.length);
        for (const id of result) expect([...current, ...added]).toContain(id);

        const newlyAdded = added.filter((id) => !current.includes(id));
        const touched = new Set(
          newlyAdded.map((id) => exclusiveGroup(u.labels, id)).filter((g) => g !== undefined),
        );

        for (const group of touched) {
          // Exactly one label of the group: the last one the write newly added.
          const ofGroup = result.filter((id) => exclusiveGroup(u.labels, id) === group);
          const last = newlyAdded.filter((id) => exclusiveGroup(u.labels, id) === group).at(-1);
          expect(ofGroup).toEqual([last]);
        }

        for (const id of new Set([...current, ...added])) {
          const group = exclusiveGroup(u.labels, id);
          // Labels outside the groups the write added to are all kept (multi-select groups,
          // untouched exclusive groups even with two labels, loose and unknown labels).
          if (group === undefined || !touched.has(group)) expect(result).toContain(id);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('changes nothing when the write adds nothing new', () => {
    fc.assert(
      fc.property(scenario, ({ u, current }) => {
        expect(applyLabelAdd(u.labels, current, current)).toEqual([...new Set(current)]);
        expect(applyLabelAdd(u.labels, current, [])).toEqual([...new Set(current)]);
      }),
    );
  });
});
