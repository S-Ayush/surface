// PLAN-015 S2, SPEC-015 §4.5 (AC-4, guarding later plans): every table with a foreign key to
// `issues`, read from the Drizzle schema, has a purge step, except `issue_search_text`, whose key
// cascades (D19); every other such key is RESTRICT, so a missing step would fail the purge
// loudly. The same holds a level down and further: a table keyed to `comments` (or to any other
// table the purge empties) without ON DELETE CASCADE needs its own step, or purges fail. Steps run children first: no step deletes rows another table's later step still
// references. A table with an `issue_id` column and no foreign key is listed, so a new child
// can't slip past the guard by leaving its key out. The comment steps' own SQL and chunking are
// `comment-purge-step.test.ts`'s; the content steps' calls are here.
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema/index.js';
import {
  ISSUE_CONTENT_PURGE_STEPS,
  LOG_CONTENT_DELETES,
  PURGE_STEPS,
  type PurgeStep,
} from '../src/issues/purge-steps.js';
import { SYNCED_MODELS } from '../src/sync/models.js';
import type { Repo } from '../src/sync/repo.js';
import { recordingDb } from './support/scripted-db.js';

const ISSUE = '0190f0c0-0000-7000-8000-000000000042';

const tables = Object.values<unknown>(schema).flatMap((value) =>
  value instanceof PgTable ? [value] : [],
);
// Generic like `getTableConfig`: `instanceof` and a key's reference both give `PgTable<any>`.
const nameOf = <T extends PgTable>(table: T) => getTableConfig(table).name;

/** Each foreign key of the schema: from table, to table, and its ON DELETE. */
const foreignKeys = tables.flatMap((table) =>
  getTableConfig(table).foreignKeys.map((fk) => ({
    from: nameOf(table),
    to: nameOf(fk.reference().foreignTable),
    onDelete: fk.onDelete,
  })),
);

/**
 * The tables a purge empties rows of, from `issues` down every foreign key, and of those, the
 * ones whose key doesn't cascade: each needs a step.
 */
function purgedFrom(root: string): { reached: Set<string>; needSteps: Set<string> } {
  const reached = new Set([root]);
  const needSteps = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const fk of foreignKeys) {
      if (fk.from === fk.to || !reached.has(fk.to)) continue;
      if (fk.onDelete !== 'cascade') needSteps.add(fk.from);
      if (!reached.has(fk.from)) {
        reached.add(fk.from);
        grew = true;
      }
    }
  }
  return { reached, needSteps };
}

/** The table a step deletes from. */
function tableOf(step: PurgeStep): string {
  if (step.model.startsWith('table:')) return step.model.slice('table:'.length);
  const entry = Object.entries(SYNCED_MODELS).find(([name]) => name === step.model);
  if (entry === undefined) throw new Error(`${step.model} is not a synced model`);
  return nameOf(entry[1].table);
}

/**
 * Tables with an `issue_id` column but no foreign key to `issues`, and why. A new one fails the
 * test below until it is listed here or gets its key (and a purge step).
 */
const UNKEYED_ISSUE_COLUMNS: Readonly<Record<string, string>> = {
  // On purpose: a draft must not block a purge, nor tell whether an issue exists (SPEC-012 §4.3).
  drafts: 'SPEC-012 §4.3',
  // PLAN-014 S4a adds the key, and the purge step for the issue's files (`deleteFiles`), in one
  // change: then this entry goes and the guard above holds it.
  files: 'PLAN-014 S4a',
};

describe('the purge-step registry (SPEC-015 §4.5)', () => {
  it('has a step for every table with a foreign key to issues', () => {
    const children = foreignKeys.filter((fk) => fk.to === 'issues' && fk.from !== 'issues');
    expect(children.length).toBeGreaterThan(0);
    const stepped = new Set(PURGE_STEPS.map(tableOf));
    const missing = children
      .filter((fk) => fk.onDelete !== 'cascade' && !stepped.has(fk.from))
      .map((fk) => fk.from);
    expect(missing, 'tables with a key to issues and no purge step').toEqual([]);
  });

  it('has a step for every table under those whose key doesn’t cascade (grandchildren too)', () => {
    const { reached, needSteps } = purgedFrom('issues');
    // Reactions sit under comments: the walk goes past the first level.
    expect(reached.has('reactions')).toBe(true);
    const stepped = new Set(PURGE_STEPS.map(tableOf));
    const missing = [...needSteps].filter((table) => !stepped.has(table)).sort();
    expect(missing, 'tables under issues with a non-cascading key and no purge step').toEqual([]);
  });

  it('has RESTRICT keys to issues, except the server-only issue_search_text (D19)', () => {
    const toIssues = foreignKeys.filter((fk) => fk.to === 'issues');
    for (const fk of toIssues) {
      expect(fk.onDelete, fk.from).toBe(fk.from === 'issue_search_text' ? 'cascade' : 'restrict');
    }
  });

  it('lists every table with an issue_id column and no key to issues', () => {
    const keyed = new Set(foreignKeys.filter((fk) => fk.to === 'issues').map((fk) => fk.from));
    const unkeyed = tables
      .filter((table) =>
        // The schema leaves names to the `snake_case` casing, so a column may be named either way;
        // `parent_issue_id` and the like count too.
        getTableConfig(table).columns.some((column: PgColumn) => /issue_?id$/i.test(column.name)),
      )
      .map(nameOf)
      .filter((name) => !keyed.has(name));
    expect(unkeyed.sort()).toEqual(Object.keys(UNKEYED_ISSUE_COLUMNS).sort());
  });

  it('runs children first: no step deletes a table a later step’s table references', () => {
    const order = PURGE_STEPS.map(tableOf);
    for (const [i, table] of order.entries()) {
      const laterChildren = foreignKeys.filter(
        (fk) => fk.to === table && fk.from !== table && order.indexOf(fk.from) > i,
      );
      expect(laterChildren, `${table} is purged before its children`).toEqual([]);
    }
  });

  it('registers each table once', () => {
    const order = PURGE_STEPS.map(tableOf);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe('the content steps (PLAN-015 S2)', () => {
  it('delete the issue’s history and content by issueId, unlogged (ADR-0022)', async () => {
    const calls: string[] = [];
    const refuse = () => Promise.reject(new Error('a purge step only deletes'));
    const repo: Repo = {
      insert: refuse,
      update: refuse,
      archive: refuse,
      unarchive: refuse,
      purge: refuse,
      updateWhere: refuse,
      deleteWhere(model, field, ids, options) {
        calls.push(`${model}.${field} in [${ids.join(',')}] log=${String(options?.log ?? true)}`);
        return Promise.resolve([]);
      },
      changes: () => [],
    };
    const { db, statements } = recordingDb();
    for (const step of ISSUE_CONTENT_PURGE_STEPS) await step.step(db, repo, ISSUE);
    expect(calls).toEqual([
      `IssueHistory.issueId in [${ISSUE}] log=false`,
      `IssueContent.issueId in [${ISSUE}] log=false`,
    ]);
    expect(statements).toEqual([]);
    expect(LOG_CONTENT_DELETES).toBe(false);
    for (const step of ISSUE_CONTENT_PURGE_STEPS) expect(PURGE_STEPS).toContain(step);
  });
});
