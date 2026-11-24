// PLAN-010 S5, SPEC-010 AC-6 (property part): for any workflow and issue set, `statusDeleteProblem`
// over `countStatusIssues` counts live, archived and recently deleted issues and never permanently
// deleted ones (they have no row). A delete it allows leaves no issue on the status and keeps INV-04
// and INV-05 (`workflowProblems` is empty); it never allows one while any stored issue uses it.
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { EDITABLE_STATUS_CATEGORIES, countStatusIssues, statusDeleteProblem } from './workflow.js';
import { DEFAULT_TEAM_WORKFLOW, workflowProblems } from './workspace.js';

const LIFECYCLES = ['live', 'archived', 'deleted', 'archivedThenDeleted', 'purged'] as const;
const AT = '2026-11-16T10:00:00.000Z';

const scenario = fc
  .record({
    extra: fc.array(fc.constantFrom(...EDITABLE_STATUS_CATEGORIES), { maxLength: 6 }),
    issues: fc.array(fc.record({ status: fc.nat(), lifecycle: fc.constantFrom(...LIFECYCLES) }), {
      maxLength: 12,
    }),
    defaultPick: fc.nat(),
    target: fc.nat(),
  })
  .map(({ extra, issues, defaultPick, target }) => {
    const statuses = [
      ...DEFAULT_TEAM_WORKFLOW.map((s, i) => ({ id: `s${i}`, name: s.name, category: s.category })),
      ...extra.map((category, i) => ({ id: `x${i}`, name: `Extra ${i}`, category })),
    ];
    const defaults = statuses.filter((s) => ['backlog', 'unstarted'].includes(s.category));
    const defaultStatusId = defaults[defaultPick % defaults.length]?.id ?? 's0';
    // A purged issue has no row: it never reaches the count.
    const rows = issues
      .filter((issue) => issue.lifecycle !== 'purged')
      .map((issue) => ({
        statusId: statuses[issue.status % statuses.length]?.id ?? 's0',
        archivedAt: issue.lifecycle.startsWith('archived') ? AT : null,
        deletedAt: issue.lifecycle.endsWith('eleted') ? AT : null,
      }));
    const statusId = statuses[target % statuses.length]?.id ?? 's0';
    return { statuses, defaultStatusId, rows, statusId };
  });

describe('statusDeleteProblem over any workflow and issue set (AC-6)', () => {
  it('allows a delete only when no stored issue uses the status, and keeps INV-04 and INV-05', () => {
    fc.assert(
      fc.property(scenario, ({ statuses, defaultStatusId, rows, statusId }) => {
        expect(workflowProblems(statuses, defaultStatusId)).toEqual([]);
        const counts = countStatusIssues(rows, statusId);
        const onStatus = rows.filter((row) => row.statusId === statusId);
        expect(counts.live + counts.archived + counts.recentlyDeleted).toBe(onStatus.length);

        const problem = statusDeleteProblem({ statuses, statusId }, defaultStatusId, counts);
        if (problem === undefined) {
          // Allowed: no issue points at the status afterwards, and the workflow stays valid.
          expect(onStatus).toEqual([]);
          const after = statuses.filter((s) => s.id !== statusId);
          expect(workflowProblems(after, defaultStatusId)).toEqual([]);
        } else if (problem.reason === 'hasIssues') {
          expect(onStatus.length).toBeGreaterThan(0);
          expect(problem.message).toContain(
            `It has ${onStatus.length} issue${onStatus.length === 1 ? '' : 's'}`,
          );
          const hidden = onStatus.filter((r) => r.archivedAt !== null || r.deletedAt !== null);
          if (hidden.length > 0) {
            expect(problem.message).toContain(`(${hidden.length} archived or recently deleted)`);
          } else {
            expect(problem.message).not.toContain('archived');
          }
        }
      }),
      propertyParameters({ numRuns: 1000 }),
    );
  });
});
