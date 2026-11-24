// PLAN-014 S4a, SPEC-014 §4.1, SPEC-011 §5.7: Attachment is an eager child of Issue in the
// production models, so the client drops an issue's attachments when a batch leaves the issue
// absent (an `A`, a delete's `U`, a purge's `D`) and keeps them through a `D`+`U` group change; a
// restore's `V` or `U` brings the issue back and the Attachment `U`s `issue.restore` logs after it
// bring the attachments back, with no refetch. The generic engine is `issue-removal.test.ts`'s (on
// stand-in models, through a fake hub); this runs the delta planner on the real ones.
import { EAGER_ISSUE_CHILDREN, PRODUCTION_MODELS } from '@surface/domain/model';
import type { DeltaPacket } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { planDeltas } from '../src/deltas.js';
import { ISSUE_CHILDREN, partialRules } from '../src/partial.js';
import { ObjectPool } from '../src/pool.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const OTHER = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
const AT = '2026-11-16T10:00:00.000Z';
const A1 = '0192f0c1-7e5a-7b3c-9d4e-000000000a01';
const A2 = '0192f0c1-7e5a-7b3c-9d4e-000000000a02';
const A3 = '0192f0c1-7e5a-7b3c-9d4e-000000000a03';

function issueRow(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    teamId: ENG,
    number: 1,
    title: 'Fix login',
    statusId: ENG,
    priority: 0,
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    sortOrder: 'a1',
    creatorId: ADA,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedById: null,
    groups: [`team:${ENG}`],
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

function attachmentRow(id: string, issueId: string) {
  return {
    id,
    issueId,
    teamId: ENG,
    kind: 'link',
    title: 'Login flow',
    url: 'https://example.com/',
    fileId: null,
    fileName: null,
    mimeType: null,
    size: null,
    imageWidth: null,
    imageHeight: null,
    previewFileId: null,
    creatorId: ADA,
    groups: [`team:${ENG}`],
    createdAt: AT,
    updatedAt: AT,
  };
}

const rules = partialRules(PRODUCTION_MODELS, undefined);

/** A pool holding ISSUE with A1 and A2, and OTHER with A3. */
function replica() {
  const pool = new ObjectPool(PRODUCTION_MODELS);
  pool.applyBase([
    { kind: 'upsert', model: 'Issue', row: issueRow(ISSUE) },
    { kind: 'upsert', model: 'Issue', row: issueRow(OTHER) },
    { kind: 'upsert', model: 'Attachment', row: attachmentRow(A1, ISSUE) },
    { kind: 'upsert', model: 'Attachment', row: attachmentRow(A2, ISSUE) },
    { kind: 'upsert', model: 'Attachment', row: attachmentRow(A3, OTHER) },
  ]);
  return pool;
}

/** Plans `packets` (ids from 11) and applies the base changes; the replica's attachment ids. */
function apply(pool: ObjectPool, packets: readonly DeltaPacket[]): string[] {
  const plan = planDeltas(
    pool,
    { t: 'deltas', prev: 10, packets: [...packets], ack: [] },
    10,
    rules,
  );
  if (plan.kind !== 'apply') throw new Error(`expected an apply plan, got ${plan.kind}`);
  pool.applyBase(plan.base);
  return pool
    .all('Attachment')
    .map((row) => row.id)
    .sort();
}

describe('Attachment rows leave and return with their issue (SPEC-014 §4.1)', () => {
  it('is registered as an eager child of Issue in production', () => {
    expect(EAGER_ISSUE_CHILDREN).toContainEqual({ model: 'Attachment', field: 'issueId' });
    expect(ISSUE_CHILDREN).toBe(EAGER_ISSUE_CHILDREN);
    expect(rules?.shape.children).toContainEqual({ model: 'Attachment', field: 'issueId' });
  });

  it.each([
    ['an archive (A)', { id: 11, a: 'A', m: 'Issue', d: issueRow(ISSUE, { archivedAt: AT }) }],
    ['a delete (U)', { id: 11, a: 'U', m: 'Issue', d: issueRow(ISSUE, { deletedAt: AT }) }],
    ['a purge (D)', { id: 11, a: 'D', m: 'Issue', mid: ISSUE }],
  ] as const)('removes the issue’s attachments, and only its, on %s', (_name, packet) => {
    const pool = replica();
    expect(apply(pool, [packet])).toEqual([A3]);
    expect(pool.get('Issue', ISSUE)).toBeUndefined();
  });

  it('keeps them through a group change (D then U in one batch)', () => {
    const pool = replica();
    const remaining = apply(pool, [
      { id: 11, a: 'D', m: 'Issue', mid: ISSUE },
      { id: 12, a: 'U', m: 'Issue', d: issueRow(ISSUE, { assigneeId: ADA }) },
    ]);
    expect(remaining).toEqual([A1, A2, A3]);
  });

  it.each(['V', 'U'] as const)(
    'brings them back on a restore %s followed by the re-logged Attachment Us, with no refetch',
    (action) => {
      const pool = replica();
      apply(pool, [{ id: 11, a: 'U', m: 'Issue', d: issueRow(ISSUE, { deletedAt: AT }) }]);
      expect(pool.get('Issue', ISSUE)).toBeUndefined();
      const plan = planDeltas(
        pool,
        {
          t: 'deltas',
          prev: 11,
          packets: [
            { id: 12, a: action, m: 'Issue', d: issueRow(ISSUE) },
            { id: 13, a: 'U', m: 'Attachment', d: attachmentRow(A1, ISSUE) },
            { id: 14, a: 'U', m: 'Attachment', d: attachmentRow(A2, ISSUE) },
          ],
          ack: [],
        },
        11,
        rules,
      );
      if (plan.kind !== 'apply') throw new Error('expected an apply plan');
      pool.applyBase(plan.base);
      expect(pool.get('Issue', ISSUE)).toBeDefined();
      expect(
        pool
          .all('Attachment')
          .map((row) => row.id)
          .sort(),
      ).toEqual([A1, A2, A3]);
    },
  );

  it('drops an attachment that arrives in the same batch as its issue’s archive', () => {
    const pool = replica();
    const A4 = '0192f0c1-7e5a-7b3c-9d4e-000000000a04';
    const remaining = apply(pool, [
      { id: 11, a: 'I', m: 'Attachment', d: attachmentRow(A4, ISSUE) },
      { id: 12, a: 'A', m: 'Issue', d: issueRow(ISSUE, { archivedAt: AT }) },
    ]);
    expect(remaining).toEqual([A3]);
  });
});
