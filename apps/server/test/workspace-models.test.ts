// PLAN-001 S1: the workspace and team models as the server registers them. The client store
// and the server must agree on the model list (one schema hash), every declared field must have
// a column of a matching type and nullability (or the client store rejects the row), and no
// server-only column may be declared.
import type { FieldKind } from '@surface/domain/model';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { computeSchemaHash } from '@surface/sync-protocol';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { sessions, teamIssueCounters, userCredentials } from '../src/db/schema/index.js';
import { SYNCED_MODELS } from '../src/sync/models.js';
import { loggedRow } from '../src/sync/repo.js';
import { GROUPS_FIELD, syncRegistry } from '../src/sync/registry.js';

const production = syncRegistry({ includeFixtures: false });

/** The Drizzle column types each field kind may be stored in. */
const COLUMN_TYPES: Readonly<Record<FieldKind, readonly string[]>> = {
  uuid: ['PgUUID'],
  string: ['PgText'],
  enum: ['PgText'],
  int: ['PgInteger'],
  bool: ['PgBoolean'],
  timestamp: ['PgTimestamp'],
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

  it('is all bootstrapped', () => {
    expect(production.eager.map((m) => m.name)).toEqual(PRODUCTION_MODELS.map((m) => m.name));
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

  it('carries its groups to the client exactly when it belongs to a team', () => {
    expect(GROUPS_FIELD in def.fields).toBe(entry.teamColumn !== null);
  });
});

describe('server-only tables', () => {
  it('hold the secrets and counters, and are not synced', () => {
    const synced = new Set(Object.values(SYNCED_MODELS).map((m) => getTableConfig(m.table).name));
    for (const table of [userCredentials, teamIssueCounters, sessions]) {
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
