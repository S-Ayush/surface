// PLAN-010 S5, SPEC-010 AC-26, §5, §6, D15: `label.usage`'s query builders and its result shaping.
// The labels are scoped as `label.list` scopes them (archived ones included) and filtered by the
// actor's visible groups and a key's teams; the usage query counts issues that aren't deleted
// (archived ones count), that the actor can see, once per label and team. The SQL against
// Postgres is ⏸ held (`label-usage.int.test.ts`); the private-team half is in
// `label-leak.int.test.ts`.
import type { Actor } from '@surface/domain';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../src/executor/context.js';
import labelUsage, {
  labelScopeCondition,
  shapeUsage,
  usageStatement,
  type UsageRow,
} from '../src/handlers/labels/usage.js';
import { recordingDb } from './support/scripted-db.js';

const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const DES = '0190f0c0-0000-7000-8000-00000000d000';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const BUG = '0190f0c0-0000-7000-8000-0000000000b1';
const UI = '0190f0c0-0000-7000-8000-0000000000b2';
const OLD = '0190f0c0-0000-7000-8000-0000000000b3';

const ada: Actor = {
  kind: 'user',
  userId: ADA,
  groups: ['workspace', `user:${ADA}`],
  publicTeams: [ENG, DES],
  memberOf: [ENG],
};
const narrowed: Actor = {
  ...ada,
  kind: 'api',
  apiKey: { id: 'key', scope: 'read', teamIds: [ENG], allowDestructive: false },
};

const dialect = new PgDialect({ casing: 'snake_case' });
const render = (fragment: SQL | undefined) =>
  fragment === undefined ? { sql: '', params: [] } : dialect.sqlToQuery(fragment);

describe('the labels in scope (as label.list, archived included)', () => {
  it('always filters by the actor’s visible groups, every public team’s included', () => {
    const { sql, params } = render(labelScopeCondition(ada, { scope: 'all' }));
    expect(sql).toBe('"labels"."sync_groups" && $1');
    expect(String(params[0])).toContain(`team:${DES}`);
    expect(sql).not.toContain('archived_at');
  });

  it('workspace scope is the workspace’s labels', () => {
    expect(render(labelScopeCondition(ada, { scope: 'workspace', teamId: ENG })).sql).toBe(
      '("labels"."sync_groups" && $1 and "labels"."team_id" is null)',
    );
  });

  it('team scope is the named team’s labels, or every team’s without one', () => {
    const named = render(labelScopeCondition(ada, { scope: 'team', teamId: ENG }));
    expect(named.sql).toBe('("labels"."sync_groups" && $1 and "labels"."team_id" = $2)');
    expect(named.params[1]).toBe(ENG);
    expect(render(labelScopeCondition(ada, { scope: 'team' })).sql).toBe(
      '("labels"."sync_groups" && $1 and "labels"."team_id" is not null)',
    );
  });

  it('all scope with a team is the team’s labels plus the workspace’s', () => {
    expect(render(labelScopeCondition(ada, { scope: 'all', teamId: ENG })).sql).toBe(
      '("labels"."sync_groups" && $1 and ("labels"."team_id" = $2 or "labels"."team_id" is null))',
    );
  });

  it('a key narrowed to some teams sees only their labels and the workspace’s', () => {
    const { sql, params } = render(labelScopeCondition(narrowed, { scope: 'all' }));
    expect(sql).toBe(
      '("labels"."sync_groups" && $1 and ("labels"."team_id" is null or "labels"."team_id" in ($2)))',
    );
    expect(params[1]).toBe(ENG);
  });
});

describe('the usage query (AC-26)', () => {
  it('counts issues that aren’t deleted, archived ones included, that carry the labels', () => {
    const { sql, params } = render(usageStatement(ada, [BUG, UI]));
    expect(sql).toContain('"issues"."deleted_at" IS NULL');
    expect(sql).not.toContain('archived_at');
    // The GIN index finds the issues; the lateral unnest counts an issue once in each label.
    expect(sql).toContain('WHERE "issues"."label_ids" && $1::uuid[]');
    expect(sql).toContain('CROSS JOIN LATERAL unnest("issues"."label_ids") AS l(label_id)');
    expect(sql).toContain('AND l.label_id = ANY($2::uuid[])');
    expect(sql).toContain('GROUP BY 1, 2, 3, 4');
    expect(params[0]).toEqual([BUG, UI]);
  });

  it('counts only issues the actor can see, and a narrowed key’s teams only', () => {
    const user = render(usageStatement(ada, [BUG]));
    expect(user.sql).toContain('"issues"."sync_groups" && $3');
    expect(String(user.params[2])).toContain(`team:${ENG}`);
    expect(user.sql).not.toContain('"issues"."team_id" in');
    const key = render(usageStatement(narrowed, [BUG]));
    expect(key.sql).toContain('"issues"."team_id" in ($4)');
    expect(key.params[3]).toBe(ENG);
  });
});

describe('the answer (AC-26)', () => {
  const row = (labelId: string, team: 'ENG' | 'DES', issues: number, at: Date | string) => ({
    labelId,
    teamId: team === 'ENG' ? ENG : DES,
    teamKey: team,
    teamName: team === 'ENG' ? 'Engineering' : 'Design',
    issues,
    lastAppliedAt: at,
  });

  it('sums each label over its teams, lists the teams by key and the latest update', () => {
    const rows: UsageRow[] = [
      row(BUG, 'ENG', 3, new Date('2026-11-10T09:00:00.000Z')),
      row(BUG, 'DES', 2, '2026-11-12 08:30:00+00'),
      row(UI, 'ENG', 1, new Date('2026-11-01T00:00:00.000Z')),
    ];
    const out = shapeUsage(
      [
        { id: BUG, name: 'Bug' },
        { id: OLD, name: 'Old' },
        { id: UI, name: 'UI' },
      ],
      rows,
    );
    expect(out.labels).toEqual([
      {
        label: { id: BUG, name: 'Bug' },
        issues: 5,
        teams: [
          { id: DES, key: 'DES', name: 'Design' },
          { id: ENG, key: 'ENG', name: 'Engineering' },
        ],
        lastAppliedAt: '2026-11-12T08:30:00.000Z',
      },
      // A label no visible issue carries is listed with nothing.
      { label: { id: OLD, name: 'Old' }, issues: 0, teams: [], lastAppliedAt: null },
      {
        label: { id: UI, name: 'UI' },
        issues: 1,
        teams: [{ id: ENG, key: 'ENG', name: 'Engineering' }],
        lastAppliedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('the label.usage handler', () => {
  function run(labels: unknown[][], usage: Record<string, unknown>[]) {
    const { db, statements } = recordingDb((text) => {
      if (text.includes('from "labels"')) return labels;
      if (text.includes('FROM "issues"')) return usage as unknown as unknown[][];
      return [];
    });
    const ctx = {
      actor: ada,
      tx: db,
      refs: { team: { id: ENG, key: 'ENG' } },
    } as unknown as HandlerContext;
    return { statements, out: labelUsage.run(ctx, { team: 'ENG', scope: 'all' }) };
  }

  it('reads the labels in name order, at most 1,000, then their usage in one query', async () => {
    const { statements, out } = run(
      [
        [BUG, 'Bug'],
        [UI, 'UI'],
      ],
      [
        {
          labelId: BUG,
          teamId: ENG,
          teamKey: 'ENG',
          teamName: 'Engineering',
          issues: 4,
          lastAppliedAt: new Date('2026-11-15T00:00:00.000Z'),
        },
      ],
    );
    expect(await out).toEqual({
      labels: [
        {
          label: { id: BUG, name: 'Bug' },
          issues: 4,
          teams: [{ id: ENG, key: 'ENG', name: 'Engineering' }],
          lastAppliedAt: '2026-11-15T00:00:00.000Z',
        },
        { label: { id: UI, name: 'UI' }, issues: 0, teams: [], lastAppliedAt: null },
      ],
    });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.text).toMatch(
      /^select "id", "name" from "labels" where .* order by "labels"\."name", "labels"\."id" limit \$\d+$/,
    );
    expect(statements[0]?.params).toContain(1000);
    expect(statements[1]?.params[0]).toEqual([BUG, UI]);
  });

  it('asks nothing about issues when no label is in scope', async () => {
    const { statements, out } = run([], []);
    expect(await out).toEqual({ labels: [] });
    expect(statements).toHaveLength(1);
  });
});
