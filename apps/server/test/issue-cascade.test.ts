// PLAN-011 S4, SPEC-011 §4.9: AC-17 (unit part: the cascade function) and E20. `label.delete`
// (PLAN-010 S5) calls `removeLabelFromIssues` holding the label row; it hands every issue with the
// label, whatever its lifecycle state, to the repo in one `updateWhere` with `touchUpdatedAt:
// false`, and records no history and emits no event. The run against Postgres is ⏸ held with
// PLAN-010 S5 (`label-delete-cascade.int.test.ts`).
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { removeLabelFromIssues } from '../src/issues/cascade.js';
import { memoryIssues } from './support/memory-issues.js';
import { recordingDb } from './support/scripted-db.js';

const LABEL = '0190f0c0-0000-7000-8000-0000000000b1';
// One live, one archived and one deleted issue: the read has no lifecycle condition, so the
// database answers all three.
const ISSUES = [
  '0190f0c0-0000-7000-8000-000000000003',
  '0190f0c0-0000-7000-8000-000000000001',
  '0190f0c0-0000-7000-8000-000000000002',
];

function issuesWithLabel(ids: readonly string[]) {
  return recordingDb((text) =>
    text.startsWith('select "id" from "issues"') ? ids.map((id) => [id]) : [],
  );
}

describe('removeLabelFromIssues (AC-17, E20)', () => {
  it('reads every issue carrying the label, whatever its state, in id order', async () => {
    const { db, statements } = issuesWithLabel(ISSUES);
    await removeLabelFromIssues(db, memoryIssues().repo, LABEL);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe(
      'select "id" from "issues" where "issues"."label_ids" @> ARRAY[$1]::uuid[] order by "issues"."id"',
    );
    expect(statements[0]?.params).toEqual([LABEL]);
    expect(statements[0]?.text).not.toMatch(/archived_at|deleted_at/);
  });

  it('rewrites them in one logged updateWhere that leaves updatedAt alone, with no event', async () => {
    const { db } = issuesWithLabel(ISSUES);
    const m = memoryIssues();
    const rewritten = await removeLabelFromIssues(db, m.repo, LABEL);
    expect(m.writes.map(({ patch: _patch, ...write }) => write)).toEqual([
      { action: 'updateWhere', ids: ISSUES, fields: ['labelIds'], touchUpdatedAt: false },
    ]);
    // Computed per row in SQL, so a concurrent edit of the issue's other labels is kept.
    const value = m.writes[0]?.patch?.['labelIds'];
    if (!(value instanceof SQL)) throw new Error('labelIds should be computed in SQL');
    // Rendered as the repo renders it (the app's drizzle uses snake_case).
    expect(new PgDialect({ casing: 'snake_case' }).sqlToQuery(value)).toMatchObject({
      sql: 'array_remove("issues"."label_ids", $1::uuid)',
      params: [LABEL],
    });
    expect(rewritten).toEqual([...ISSUES].sort());
    expect(m.events).toEqual([]);
  });

  it('writes nothing when no issue carries the label', async () => {
    const { db } = issuesWithLabel([]);
    const m = memoryIssues();
    expect(await removeLabelFromIssues(db, m.repo, LABEL)).toEqual([]);
    expect(m.writes).toEqual([]);
  });
});
