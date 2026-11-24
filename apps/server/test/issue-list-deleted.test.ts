// SPEC-015 AC-9 (query part), AC-10 (`teamIds` in SQL), AC-19 (leaves out issues past
// `purgeAfter`), E13; PLAN-015 S4: `issue.listDeleted` lists deleted issues only (archived or
// not), only while `now < purgeAfter`, newest deletion first, with visibility and an API key's
// teams in SQL before anything else, and each node carries `deletedBy` and `purgeAfter`. The SQL
// is checked as Drizzle builds it on a recording connection; Postgres runs it in the leak test
// (`issue-leak.int.test.ts`) and the registry contract.
import { bindPredicates, purgeAfter, RETENTION_HOURS, type Actor } from '@surface/domain';
import { issueListDeleted, LIST_LIMIT_DEFAULT } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db/pool.js';
import { queryHelpers, type HandlerContext } from '../src/executor/context.js';
import { narrowToKeyTeams } from '../src/executor/key-scope.js';
import { HANDLERS } from '../src/handlers/index.js';
import listDeleted from '../src/handlers/issues/list-deleted.js';
import { deletedIssueListModel, issueListModel } from '../src/handlers/issues/list-model.js';
import { recordingDb, type Statement } from './support/scripted-db.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const OTHER_TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const STATUS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const DELETED_AT = '2026-11-10T08:00:00.000Z';

const MEMBER: Actor = {
  kind: 'user',
  userId: ADA,
  role: 'member',
  groups: ['workspace', `user:${ADA}`, `team:${TEAM}`],
  publicTeams: [],
  memberOf: [TEAM],
};

const keyActor = (teamIds: string[]): Actor => ({
  ...MEMBER,
  kind: 'api',
  apiKey: { id: 'k1', scope: 'read', teamIds, allowDestructive: false },
});

/** The `issues` row as the database returns it, keyed by column name. */
const ISSUE_ROW: Record<string, unknown> = {
  id: ISSUE,
  team_id: TEAM,
  number: 42,
  title: 'Login page flickers',
  status_id: STATUS,
  priority: 2,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  due_date: null,
  sort_order: 'a0',
  creator_id: ADA,
  started_at: null,
  completed_at: null,
  canceled_at: null,
  archived_at: '2026-10-01T00:00:00.000Z',
  deleted_at: DELETED_AT,
  deleted_by_id: ADA,
  sync_groups: [`team:${TEAM}`],
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: DELETED_AT,
};

/** Answers each statement from small tables, in the column order of its select list. */
function database() {
  const tables: Record<string, Record<string, unknown>[]> = {
    issues: [ISSUE_ROW],
    teams: [{ id: TEAM, key: 'ENG' }],
    workflow_statuses: [{ id: STATUS, name: 'Done', category: 'completed' }],
    users: [{ id: ADA, name: 'Ada Lovelace' }],
    labels: [],
  };
  return recordingDb((text) => {
    const match = /^select (.+?) from "(\w+)"/.exec(text);
    if (match?.[1] === undefined || match[2] === undefined) return [];
    const columns = match[1].split(', ').map((c) => c.replace(/^.*"(\w+)"$/, '$1'));
    return (tables[match[2]] ?? []).map((row) => columns.map((name) => row[name] ?? null));
  });
}

// The list never resolves a reference through the client here (the input names no team), so a
// client that refuses every query stands in for a `pg` pool.
const noClient = {
  query: () => Promise.reject(new Error('no reference lookups here')),
} as unknown as Queryable;

function contextFor(actor: Actor, db: ReturnType<typeof database>['db']): HandlerContext {
  const ctx: Pick<HandlerContext, 'actor' | 'refs' | 'tx' | 'query' | 'publicUrl' | 'now'> = {
    actor,
    refs: {},
    tx: db,
    query: queryHelpers(db, noClient, actor, NOW),
    publicUrl: 'https://surface.test',
    now: () => NOW,
  };
  // The handler reads only these fields.
  return ctx as HandlerContext;
}

const selectFromIssues = (statements: readonly Statement[]): Statement => {
  const statement = statements.find((s) => /^select .* from "issues"/.test(s.text));
  if (statement === undefined) throw new Error('no select from issues');
  return statement;
};

async function listAs(actor: Actor, input: Record<string, unknown> = {}) {
  const { db, statements } = database();
  const output = await listDeleted.run(
    contextFor(actor, db),
    issueListDeleted.input.parse({ ...input }),
  );
  return { output, select: selectFromIssues(statements) };
}

describe('issue.listDeleted', () => {
  it('is registered, a query anyone who sees the issues may run, and a read-only key too', () => {
    expect(HANDLERS.some((h) => h.op.name === 'issue.listDeleted')).toBe(true);
    expect(issueListDeleted.kind).toBe('query');
    // E13: a Member lists the deleted issues they can see (visibility is the SQL's).
    const input = issueListDeleted.input.parse({});
    expect(issueListDeleted.permission(bindPredicates(MEMBER).p, {}, input)).toBe(true);
    expect(issueListDeleted.permission(bindPredicates(keyActor([TEAM])).p, {}, input)).toBe(true);
  });

  it('selects deleted issues before their purgeAfter only, archived or not', async () => {
    const { select } = await listAs(MEMBER);
    expect(select.text).toContain(
      '("issues"."deleted_at" IS NOT NULL AND "issues"."deleted_at" > $',
    );
    expect(select.text).toMatch(/::timestamptz - make_interval\(hours => \$\d+\)\)/);
    expect(select.params).toContain(NOW.toISOString());
    expect(select.params).toContain(RETENTION_HOURS);
    // Archived and deleted issues are deleted (SPEC-015 §4.1): no `archived_at is null`.
    expect(select.text).not.toContain('"archived_at" is null');
    expect(select.text).not.toContain('"deleted_at" is null');
  });

  it('applies the actor’s sync groups in SQL', async () => {
    const { select } = await listAs(MEMBER);
    expect(select.text).toContain('"issues"."sync_groups" && $');
    expect(JSON.stringify(select.params)).toContain(`user:${ADA}`);
    expect(JSON.stringify(select.params)).toContain(`team:${TEAM}`);
  });

  it('narrows an API key to its teams in SQL (AC-10)', async () => {
    const actor = narrowToKeyTeams(keyActor([TEAM]));
    const { select } = await listAs(actor);
    expect(select.text).toMatch(/"issues"\."team_id" in \(\$\d+\)/);
    expect(select.params).toContain(TEAM);
    expect(select.params).not.toContain(OTHER_TEAM);
  });

  it('orders by newest deletion first, 25 a page by default', async () => {
    const { select } = await listAs(MEMBER);
    expect(select.text).toContain(
      'order by "issues"."deleted_at" DESC NULLS LAST, "issues"."id" asc',
    );
    expect(select.params).toContain(LIST_LIMIT_DEFAULT + 1);
  });

  it('pages 50 at a time for the archive page', async () => {
    const { select } = await listAs(MEMBER, { limit: 50 });
    expect(select.params).toContain(51);
  });

  it('answers each issue with who deleted it and its purgeAfter', async () => {
    const { output } = await listAs(MEMBER);
    expect(output.nodes).toHaveLength(1);
    const node = output.nodes[0];
    expect(node).toMatchObject({
      identifier: 'ENG-42',
      deletedAt: DELETED_AT,
      deletedBy: { id: ADA, name: 'Ada Lovelace' },
      purgeAfter: purgeAfter(DELETED_AT).toISOString(),
    });
    // The executor validates the output with the operation's schema.
    expect(issueListDeleted.output.safeParse(output).success).toBe(true);
  });

  it('leaves the live lists as they were: `issue.list` never lists a deleted issue', () => {
    expect(issueListModel.deletedColumn).toBe('deletedAt');
    expect(deletedIssueListModel.deletedColumn).toBeUndefined();
    expect(issueListModel.scope).toBeUndefined();
  });
});
