// PLAN-001 S1: the workspace and team models as the server registers them. The client store
// and the server must agree on the model list (one schema hash), every declared field must have
// a column of a matching type and nullability (or the client store rejects the row), and no
// server-only column may be declared.
import { readdirSync, readFileSync } from 'node:fs';
import type { FieldKind } from '@surface/domain/model';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { computeSchemaHash } from '@surface/sync-protocol';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  issueContent,
  issueHistory,
  issues,
  issueSearchText,
  labels,
  sessions,
  teamIssueCounters,
  teams,
  userCredentials,
  workflowStatuses,
} from '../src/db/schema/index.js';
import { groupsOfIssueChild, SYNCED_MODELS } from '../src/sync/models.js';
import { loggedRow } from '../src/sync/repo.js';
import { GROUPS_FIELD, syncRegistry } from '../src/sync/registry.js';

const production = syncRegistry({ includeFixtures: false });

/** The Drizzle column types each field kind may be stored in. */
const COLUMN_TYPES: Readonly<Record<FieldKind, readonly string[]>> = {
  uuid: ['PgUUID'],
  string: ['PgText'],
  enum: ['PgText'],
  // `int()` is a safe integer (2^53 − 1), so a `bigint` column read in number mode fits it
  // (Attachment.size: files over 2 GB, SPEC-014 §4.2).
  int: ['PgInteger', 'PgBigInt53'],
  bool: ['PgBoolean'],
  timestamp: ['PgTimestamp'],
  day: ['PgDateString'],
  json: ['PgJsonb'],
  array: ['PgArray'],
};

/**
 * The only columns a synced table may have that its model doesn't declare: sync bookkeeping.
 * The repo logs whole rows to `sync_log` and every write is a delta, so anything else (a password
 * hash, a counter) would be stored in the log and broadcast; it belongs in a server-only table.
 */
const BOOKKEEPING_COLUMNS = new Set(['syncGroups', 'archivedAt']);

/** `groupsOf` that must not touch the database: models whose groups come from the row alone. */
const noDb: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get() {
    throw new Error('groupsOf queried the database');
  },
});

describe('the production model list', () => {
  it('is the same on the client and the server, so both compute one schema hash', () => {
    expect(production.models.map((m) => m.name)).toEqual(PRODUCTION_MODELS.map((m) => m.name));
    expect(production.schemaHash).toBe(computeSchemaHash(PRODUCTION_MODELS));
  });

  it('is bootstrapped, except the content models, which load per issue (PLAN-011 S5a)', () => {
    expect(production.eager.map((m) => m.name)).toEqual(
      PRODUCTION_MODELS.filter((m) => m.load === 'eager').map((m) => m.name),
    );
    expect(production.content.map((m) => m.name)).toEqual([
      'IssueContent',
      'IssueHistory',
      'Comment',
      'Reaction',
    ]);
  });
});

describe.each(PRODUCTION_MODELS.map((def) => [def.name, def] as const))('%s', (name, def) => {
  const entry = Object.values(SYNCED_MODELS).find((m) => m.def === def);
  if (!entry) throw new Error(`${name} is not in SYNCED_MODELS`);
  // Columns are declared without names, so `name` is the camelCase key (`casing: 'snake_case'`
  // names them in SQL), which is what model fields are called.
  const columns = new Map(getTableConfig(entry.table).columns.map((c) => [c.name, c]));

  it('stores each declared field in a column of the same type and nullability', () => {
    for (const [field, fieldDef] of Object.entries(def.fields)) {
      if (field === GROUPS_FIELD) continue;
      const column = columns.get(field);
      expect(column, `${name}.${field} has no column`).toBeDefined();
      expect(COLUMN_TYPES[fieldDef.kind], `${name}.${field}`).toContain(column?.columnType);
      expect(column?.notNull, `${name}.${field} nullability`).toBe(!fieldDef.nullable);
    }
  });

  it('has no column its model leaves out, apart from sync bookkeeping', () => {
    const undeclared = [...columns.keys()].filter(
      (column) => !(column in def.fields) && !BOOKKEEPING_COLUMNS.has(column),
    );
    expect(undeclared).toEqual([]);
  });

  // A content row needs no groups on the client: it leaves the replica with its parent (SPEC-011
  // §5.3 step 4), and its parent carries the groups.
  it('carries its groups to the client exactly when it is an eager row of a team', () => {
    expect(GROUPS_FIELD in def.fields).toBe(entry.teamColumn !== null && def.load === 'eager');
  });
});

// PLAN-010 S1, SPEC-010 §4.5: the estimate options and label groups' type are synced columns
// with the spec's defaults (the per-model checks above cover type and nullability), and status
// positions compare in byte order.
describe('SPEC-010 columns', () => {
  const column = (table: Parameters<typeof getTableConfig>[0], name: string) =>
    getTableConfig(table).columns.find((c) => c.name === name);

  it('default the estimate options to off, off and on', () => {
    expect(column(teams, 'estimateExtended')?.default).toBe(false);
    expect(column(teams, 'estimateAllowZero')?.default).toBe(false);
    expect(column(teams, 'estimateCountUnestimatedAsOne')?.default).toBe(true);
  });

  it('make a label group single-select by default', () => {
    expect(column(labels, 'exclusive')?.default).toBe(true);
  });

  it('give status positions the C collation in a migration, since Drizzle cannot declare it', () => {
    expect(column(workflowStatuses, 'position')?.columnType).toBe('PgText');
    const dir = new URL('../migrations/', import.meta.url);
    const sql = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(new URL(file, dir), 'utf8'))
      .join('\n');
    expect(sql).toContain(
      'ALTER TABLE "workflow_statuses" ALTER COLUMN "position" SET DATA TYPE text COLLATE "C";',
    );
  });
});

/** Every SQL migration, concatenated, to check hand-written lines Drizzle can't declare. */
function migrationsSql(): string {
  const dir = new URL('../migrations/', import.meta.url);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(new URL(file, dir), 'utf8'))
    .join('\n');
}

// PLAN-011 S3, SPEC-011 §4.10: the issue tables. The Issue model's columns are checked by the
// per-model block above.
describe('SPEC-011 issue tables', () => {
  const columns = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table).columns.map((c) => c.name);

  it('give issue order keys the C collation in a migration, since Drizzle cannot declare it', () => {
    expect(migrationsSql()).toContain(
      'ALTER TABLE "issues" ALTER COLUMN "sort_order" SET DATA TYPE text COLLATE "C";',
    );
  });

  it('number issues uniquely per team, and order them by (sort_order COLLATE "C", id)', () => {
    const indexes = getTableConfig(issues).indexes.map((i) => i.config.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'issues_team_number_idx',
        'issues_sort_order_idx',
        'issues_label_ids_idx',
        'issues_title_trgm_idx',
        'issues_sync_groups_idx',
      ]),
    );
    const sql = migrationsSql();
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "issues_team_number_idx" ON "issues" USING btree ("team_id","number")',
    );
    expect(sql).toContain('USING btree ("sort_order" COLLATE "C","id")');
    expect(sql).toContain('USING gin (lower("title" COLLATE "und-x-icu") gin_trgm_ops)');
  });

  it("find a team's lowest order key by index, for the read under the counter lock", () => {
    // `firstSortKey` orders one team's issues by `sort_order COLLATE "C"` (PLAN-011 S3 review).
    expect(migrationsSql()).toContain(
      'CREATE INDEX "issues_team_sort_order_idx" ON "issues" USING btree ("team_id","sort_order" COLLATE "C")',
    );
  });

  it('keep a status of the issue’s own team, and never lose one under an issue (INV-06, AC-15)', () => {
    const [statusKey] = getTableConfig(issues).foreignKeys.filter(
      (fk) => fk.getName() === 'issues_status_team_fk',
    );
    expect(statusKey?.reference().columns.map((c) => c.name)).toEqual(['statusId', 'teamId']);
    expect(statusKey?.onDelete).toBe('restrict');
  });

  it('restrict deletes of an issue under its content and history (purge deletes them first)', () => {
    for (const table of [issueContent, issueHistory]) {
      const toIssue = getTableConfig(table).foreignKeys.find(
        (fk) => getTableConfig(fk.reference().foreignTable).name === 'issues',
      );
      expect(toIssue?.onDelete, getTableConfig(table).name).toBe('restrict');
    }
  });

  it('give the content tables sync groups and a team, ready for PLAN-011 S5a', () => {
    for (const table of [issueContent, issueHistory]) {
      expect(columns(table)).toEqual(expect.arrayContaining(['issueId', 'teamId', 'syncGroups']));
    }
    // No foreign key to API keys until M6 adds their table.
    expect(
      getTableConfig(issueHistory).foreignKeys.map((fk) => fk.reference().columns[0]?.name),
    ).not.toContain('apiKeyId');
  });

  it('put a child row in its team’s group only, from the team id the repo set', () => {
    const teamId = '0190f0c0-0000-7000-8000-00000000e000';
    expect(groupsOfIssueChild({ teamId })).toEqual([`team:${teamId}`]);
    expect(groupsOfIssueChild({})).toEqual([]);
  });
});

describe('server-only tables', () => {
  it('hold the secrets and counters, and are not synced', () => {
    const synced = new Set(Object.values(SYNCED_MODELS).map((m) => getTableConfig(m.table).name));
    for (const table of [userCredentials, teamIssueCounters, sessions, issueSearchText]) {
      expect(synced.has(getTableConfig(table).name)).toBe(false);
    }
  });
});

describe('groupsOf without the database (permissions.md §2)', () => {
  const id = '0190f0c0-0000-7000-8000-000000000001';

  it('puts the workspace and users in the workspace group', () => {
    expect(SYNCED_MODELS.Workspace.groupsOf()).toEqual(['workspace']);
    expect(SYNCED_MODELS.User.groupsOf()).toEqual(['workspace']);
  });

  it("shows a user's preferences to that user only", () => {
    expect(SYNCED_MODELS.UserPreferences.groupsOf({ id })).toEqual([`user:${id}`]);
  });

  it('puts a public team in the workspace group and a private team in its own', () => {
    expect(SYNCED_MODELS.Team.groupsOf({ id, private: false })).toEqual(['workspace']);
    expect(SYNCED_MODELS.Team.groupsOf({ id })).toEqual(['workspace']);
    expect(SYNCED_MODELS.Team.groupsOf({ id, private: true })).toEqual([`team:${id}`]);
  });

  it('puts a workspace label in the workspace group', async () => {
    expect(await SYNCED_MODELS.Label.groupsOf({ teamId: null }, noDb)).toEqual(['workspace']);
  });

  it('shows a team row without a team id to nobody', async () => {
    expect(await SYNCED_MODELS.WorkflowStatus.groupsOf({}, noDb)).toEqual([]);
  });
});

describe('the row a change logs (repo.ts, defence in depth for sync_log)', () => {
  it('keeps the declared fields, the id and the sync bookkeeping, and drops anything else', () => {
    const at = new Date('2026-11-12T10:00:00.000Z');
    const row = {
      id: 'u-1',
      email: 'ada@example.com',
      name: 'Ada',
      displayName: 'ada',
      avatarFileId: null,
      timezone: 'UTC',
      role: 'admin',
      active: true,
      createdAt: at,
      updatedAt: at,
      syncGroups: ['workspace'],
      // A column a synced table must never have (PLAN-001 S1 review), as if one slipped in.
      passwordHash: '$argon2id$secret',
    };
    const logged = loggedRow('User', row);
    expect(logged).not.toHaveProperty('passwordHash');
    const { passwordHash: _dropped, ...kept } = row;
    expect(logged).toEqual(kept);
    expect(loggedRow('Label', { id: 'l-1', archivedAt: at, syncGroups: [], extra: 1 })).toEqual({
      id: 'l-1',
      archivedAt: at,
      syncGroups: [],
    });
  });
});
