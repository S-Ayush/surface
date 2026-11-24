// PLAN-010 S1, SPEC-010 AC-10 (property part): for any labels, groups and issue labels, the
// label-write rule `applyLabelAdd` never leaves two labels of an exclusive group that the write
// added to, keeps multi-select groups and untouched groups as they were, and never invents or
// duplicates an id. PLAN-010 S5 adds the real issue shapes (`mergeLabels`, the delete cascade).
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { ISSUE_LABEL_LIMIT, LABEL_LIMIT_MESSAGE, mergeLabels } from './issue.js';
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
      propertyParameters({ numRuns: 1000 }),
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

// PLAN-010 S5: the same rule on real issue shapes. Issues carry uuid label ids (at most 20) and
// live through a sequence of `issue.update` label writes (`mergeLabels`: removes, then adds), label
// deletes (the cascade's `array_remove` on every issue, whatever its state) and moves of a label
// into a group (which read and write no issue, E6).

type Step =
  | {
      readonly kind: 'write';
      readonly issue: number;
      readonly add: readonly number[];
      readonly remove: readonly number[];
    }
  | { readonly kind: 'delete'; readonly label: number }
  | { readonly kind: 'move'; readonly label: number; readonly group: number };

const uuid = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const GROUPS = [uuid(900), uuid(901)];
const LABELS = Array.from({ length: 24 }, (_, i) => uuid(i + 1));
const labelAt = (n: number) => LABELS[n] ?? '';

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('write' as const),
      issue: fc.nat({ max: 3 }),
      add: fc.array(fc.nat({ max: LABELS.length - 1 }), { maxLength: 8 }),
      remove: fc.array(fc.nat({ max: LABELS.length - 1 }), { maxLength: 3 }),
    }),
    weight: 6,
  },
  fc.record({ kind: fc.constant('delete' as const), label: fc.nat({ max: LABELS.length - 1 }) }),
  fc.record({
    kind: fc.constant('move' as const),
    label: fc.nat({ max: LABELS.length - 1 }),
    group: fc.nat({ max: GROUPS.length - 1 }),
  }),
);

describe('label writes on real issue shapes (AC-10, E6, AC-12)', () => {
  it('keep every issue within the rule through writes, deletes and moves into groups', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: GROUPS.length, maxLength: GROUPS.length }),
        fc.array(step, { maxLength: 40 }),
        (exclusive, steps) => {
          const labels = new Map<string, LabelInfo>();
          GROUPS.forEach((id, i) => {
            labels.set(id, { parentId: null, exclusive: exclusive[i] ?? true });
          });
          // The first six labels start in the groups; the rest are loose.
          LABELS.forEach((id, i) => {
            const parentId = i < 6 ? (GROUPS[i % GROUPS.length] ?? null) : null;
            labels.set(id, { parentId, exclusive: true });
          });
          const issues: string[][] = [[], [], [], []];
          const exclusiveGroup = (id: string) => {
            const parent = labels.get(id)?.parentId;
            return parent != null && labels.get(parent)?.exclusive === true ? parent : undefined;
          };

          for (const s of steps) {
            if (s.kind === 'delete') {
              const id = labelAt(s.label);
              labels.delete(id);
              // The cascade removes the id and nothing else, keeping the order.
              for (const [i, labelIds] of issues.entries()) {
                issues[i] = labelIds.filter((l) => l !== id);
              }
              continue;
            }
            if (s.kind === 'move') {
              const label = labels.get(labelAt(s.label));
              const before = JSON.stringify(issues);
              if (label)
                labels.set(labelAt(s.label), { ...label, parentId: GROUPS[s.group] ?? null });
              // E6: a move reads and writes no issue, even one with two labels of the group now.
              expect(JSON.stringify(issues)).toBe(before);
              continue;
            }
            const current = issues[s.issue] ?? [];
            // Only live labels can be added (the handler refuses a gone one, E22), and a label
            // in both lists is refused before the merge.
            const add = s.add.map(labelAt).filter((id) => labels.has(id));
            const remove = s.remove.map(labelAt).filter((id) => !add.includes(id));
            const merged = mergeLabels(current, add, remove, labels);
            if (!merged.ok) {
              expect(merged.problem).toBe(LABEL_LIMIT_MESSAGE);
              continue;
            }
            const result = merged.labelIds;
            expect(result.length).toBeLessThanOrEqual(ISSUE_LABEL_LIMIT);
            expect(new Set(result).size).toBe(result.length);
            for (const id of remove) expect(result).not.toContain(id);
            const newlyAdded = add.filter((id) => !current.includes(id));
            for (const group of new Set(newlyAdded.map(exclusiveGroup))) {
              if (group === undefined) continue;
              // The write added to this exclusive group: exactly one of its labels is left.
              expect(result.filter((id) => exclusiveGroup(id) === group)).toHaveLength(1);
            }
            issues[s.issue] = result;
          }
          // No issue keeps a deleted label.
          for (const labelIds of issues) {
            for (const id of labelIds) expect(labels.has(id)).toBe(true);
          }
        },
      ),
      propertyParameters({ numRuns: 500 }),
    );
  });
});
