// PLAN-011 S1, SPEC-011 §5.1, AC-21 (unit part; the Postgres run is held, plans README §6):
// `repo.updateWhere` and `repo.deleteWhere`, the chunked `sync_log` insert of `flush`, and the one
// unlogged delete (ADR-0022). The statements are built by pure functions (`sync/bulk.ts`); the
// repo runs them here over a stand-in connection that keeps rows per table and records every
// statement, so the order, chunking and logging are checked without a database.
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { debugItems, labels } from '../src/db/schema/index.js';
import {
  ascendingIds,
  chunked,
  deleteWhereStatements,
  removedKey,
  SYNC_LOG_CHUNK,
  unloggedDeleteProblem,
  updateWhereProblem,
  updateWhereStatements,
  type ModelShape,
} from '../src/sync/bulk.js';
import { SYNCED_MODELS } from '../src/sync/models.js';
import { modelShape, syncRepo, type RowChange, type SyncRepoOptions } from '../src/sync/repo.js';

const NOW = new Date('2026-11-12T10:00:00.000Z');
const STORED_AT = '2026-01-01T00:00:00.000Z';

/** `id(1)` → `00000000-0000-7000-8000-000000000001`. */
const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

type Row = Record<string, unknown>;

/** The quoted column names of a `select …`/`returning …` list, in order. */
function columnList(list: string): string[] {
  return list.split(',').map((item) => {
    const names = [...item.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? '');
    return names.at(-1) ?? item.trim();
  });
}

/**
 * A connection that holds rows per table (keyed by DB column) and answers the single-table
 * statements the repo sends (select, insert, update, delete, each with a `where` on one column
 * by `= $n` or `= ANY($n::uuid[])`), plus the sync lock, `sync_state` and `sync_log`. Every
 * statement is recorded with its parameters.
 */
function fakeDb(seed: Record<string, Row[]> = {}, options: SyncRepoOptions = {}) {
  const tables = new Map<string, Map<string, Row>>();
  for (const [table, rows] of Object.entries(seed)) {
    tables.set(table, new Map(rows.map((row) => [String(row['id']), { ...row }])));
  }
  const statements: { text: string; params: unknown[] }[] = [];
  let lastSyncId = 100;
  const rowsOf = (table: string) => {
    let rows = tables.get(table);
    if (rows === undefined) tables.set(table, (rows = new Map<string, Row>()));
    return rows;
  };
  const asArrays = (rows: Row[], columns: string[]) =>
    rows.map((row) => columns.map((c) => row[c] ?? null));
  const param = (params: unknown[], at: string | undefined) => params[Number(at) - 1];
  /** The rows of `table` a `where` clause selects. */
  const matching = (table: string, where: string, params: unknown[]): Row[] => {
    const m = /^"\w+"\."(\w+)" = (?:ANY\(\$(\d+)::uuid\[\]\)|\$(\d+))$/.exec(where);
    if (!m) throw new Error(`unexpected where: ${where}`);
    const wanted = new Set(
      m[2] === undefined ? [param(params, m[3])] : (param(params, m[2]) as unknown[]),
    );
    return [...rowsOf(table).values()].filter((row) => wanted.has(row[m[1] ?? '']));
  };
  const byId = (a: Row, b: Row) => String(a['id']).localeCompare(String(b['id']));

  const client = {
    query(config: { text: string }, params: unknown[] = []) {
      const text = config.text;
      statements.push({ text, params });
      const answer = (rows: unknown[]) => Promise.resolve({ rows, rowCount: rows.length });
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return answer([]);
      if (text.startsWith('update "sync_state"')) {
        lastSyncId += Number(params[0]);
        return answer([[lastSyncId, '']]);
      }
      if (text.startsWith('insert into "sync_log"')) return answer([]);

      let m =
        /^select (.*?) from "(\w+)" where (.*?)( order by "\w+"\."id" asc)?( for update)?$/.exec(
          text,
        );
      if (m) {
        const rows = matching(m[2] ?? '', m[3] ?? '', params);
        if (m[4]) rows.sort(byId);
        return answer(asArrays(rows, columnList(m[1] ?? '')));
      }
      m = /^update "(\w+)" set (.*) where (.*) returning (.*)$/.exec(text);
      if (m) {
        const sets = [...(m[2] ?? '').matchAll(/"(\w+)" = \$(\d+)/g)].map(
          ([, column, at]) => [column ?? '', param(params, at)] as const,
        );
        const rows = matching(m[1] ?? '', m[3] ?? '', params);
        for (const row of rows) for (const [column, value] of sets) row[column] = value;
        // Postgres promises no order for RETURNING: answer in descending id.
        rows.sort(byId).reverse();
        return answer(asArrays(rows, columnList(m[4] ?? '')));
      }
      m = /^delete from "(\w+)" where (.*) returning (.*)$/.exec(text);
      if (m) {
        const table = rowsOf(m[1] ?? '');
        const rows = matching(m[1] ?? '', m[2] ?? '', params);
        for (const row of rows) table.delete(String(row['id']));
        rows.sort(byId).reverse();
        return answer(asArrays(rows, columnList(m[3] ?? '')));
      }
      m = /^insert into "(\w+)" \((.*?)\) values \((.*?)\) returning (.*)$/.exec(text);
      if (m) {
        const columns = columnList(m[2] ?? '');
        const values = (m[3] ?? '').split(', ');
        const row: Row = {};
        columns.forEach((column, i) => {
          const value = values[i] ?? 'default';
          row[column] =
            value === 'default' ? (column === 'counter' ? 0 : null) : param(params, value.slice(1));
        });
        rowsOf(m[1] ?? '').set(String(row['id']), row);
        return answer(asArrays([row], columnList(m[4] ?? '')));
      }
      return Promise.reject(new Error(`unexpected statement: ${text}`));
    },
  };
  const db = drizzle({ client: client as never, casing: 'snake_case' });
  const repo = syncRepo(db, NOW, options);
  return { db, repo, statements, rowsOf };
}

function debugRow(n: number, groups: string[] = ['workspace']): Row {
  return {
    id: id(n),
    title: `Item ${n}`,
    counter: n,
    sync_groups: groups,
    created_at: STORED_AT,
    updated_at: STORED_AT,
    archived_at: null,
  };
}

const kinds = (statements: readonly { text: string }[]) =>
  statements.map(({ text }) => text.split(' ').slice(0, 2).join(' '));

const logged = (changes: readonly RowChange[]) => changes.map((c) => `${c.action} ${c.id}`);

describe('ascendingIds and chunked', () => {
  it('lock order: distinct ids, lower-cased, in the byte order Postgres gives uuids', () => {
    expect(ascendingIds([id(3), id(1).toUpperCase(), id(2), id(1)])).toEqual([id(1), id(2), id(3)]);
  });

  it('cuts at most SYNC_LOG_CHUNK (5,000) items per chunk', () => {
    expect(SYNC_LOG_CHUNK).toBe(5_000);
    const sizes = chunked(Array.from({ length: 10_001 }, (_, i) => i)).map((c) => c.length);
    expect(sizes).toEqual([5_000, 5_000, 1]);
    expect(chunked([])).toEqual([]);
  });
});

describe('the bulk statements (SQL)', () => {
  const db = drizzle.mock({ casing: 'snake_case' });

  it('updateWhere locks each chunk in ascending id, then updates it, with one array parameter', () => {
    const ids = [id(9), id(2), id(5)];
    const [chunk] = updateWhereStatements(
      db,
      debugItems,
      ids,
      { title: 'x' },
      { touchUpdatedAt: true, now: NOW },
    );
    const lock = chunk?.lock.toSQL();
    expect(lock?.sql).toBe(
      'select "id", "title", "counter", "sync_groups", "created_at", "updated_at", "archived_at" from "debug_items" where "debug_items"."id" = ANY($1::uuid[]) order by "debug_items"."id" asc for update',
    );
    expect(lock?.params).toEqual([[id(2), id(5), id(9)]]);
    const update = chunk?.update?.toSQL();
    expect(update?.sql).toMatch(
      /^update "debug_items" set "title" = \$1, "updated_at" = \$2 where "debug_items"\."id" = ANY\(\$3::uuid\[\]\) returning /,
    );
    expect(update?.params).toEqual(['x', NOW.toISOString(), [id(2), id(5), id(9)]]);
  });

  it('updateWhere leaves updatedAt alone with touchUpdatedAt: false', () => {
    const [chunk] = updateWhereStatements(
      db,
      debugItems,
      [id(1)],
      { counter: 2 },
      { touchUpdatedAt: false, now: NOW },
    );
    const update = chunk?.update?.toSQL();
    expect(update?.sql).toMatch(/^update "debug_items" set "counter" = \$1 where /);
    expect(update?.sql.split(' where ')[0]).not.toContain('updated_at');
  });

  it('an empty patch locks and writes no column, even with touchUpdatedAt', () => {
    const chunks = updateWhereStatements(
      db,
      debugItems,
      [id(1)],
      {},
      { touchUpdatedAt: true, now: NOW },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.update).toBeUndefined();
  });

  it('deleteWhere locks the matching rows in ascending id first, then deletes them by id per chunk', () => {
    const values = [id(9), id(3)];
    const statements = deleteWhereStatements(db, labels, labels.parentId, values);
    const lock = statements.lock.toSQL();
    expect(lock.sql).toBe(
      'select "id" from "labels" where "labels"."parent_id" = ANY($1::uuid[]) order by "labels"."id" asc for update',
    );
    expect(lock.params).toEqual([[id(3), id(9)]]);
    const ids = Array.from({ length: 5_001 }, (_, i) => id(5_001 - i));
    const chunks = statements.deletes(ids);
    expect(chunks.map((c) => c.ids.length)).toEqual([5_000, 1]);
    const first = chunks[0]?.delete.toSQL();
    expect(first?.sql).toBe(
      'delete from "labels" where "labels"."id" = ANY($1::uuid[]) returning "id", "sync_groups"',
    );
    expect(first?.params[0]).toEqual(ids.slice(1).reverse());
    expect(chunks[1]?.ids).toEqual([id(5_001)]);
  });
});

describe('repo.updateWhere', () => {
  it('updates and logs one U per row, in ascending id, with each row’s stored groups', async () => {
    const { repo, statements, rowsOf } = fakeDb({
      debug_items: [debugRow(3, ['team:a']), debugRow(1, ['workspace']), debugRow(2, ['user:u'])],
    });
    const ids = await repo.updateWhere(
      'DebugItem',
      [id(3), id(1), id(2), id(7)],
      { counter: 0 },
      { touchUpdatedAt: false },
    );
    expect(ids).toEqual([id(1), id(2), id(3)]);
    expect(kinds(statements)).toEqual(['select "id",', 'update "debug_items"']);
    const changes = repo.changes();
    expect(logged(changes)).toEqual([`U ${id(1)}`, `U ${id(2)}`, `U ${id(3)}`]);
    expect(changes.map((c) => c.groups)).toEqual([['workspace'], ['user:u'], ['team:a']]);
    expect(changes[0]?.row).toMatchObject({ id: id(1), counter: 0, title: 'Item 1' });
    // touchUpdatedAt: false: the stored time stays.
    expect(rowsOf('debug_items').get(id(1))).toMatchObject({ counter: 0, updated_at: STORED_AT });
  });

  it('sets updatedAt to the transaction time with touchUpdatedAt: true', async () => {
    const { repo, rowsOf } = fakeDb({ debug_items: [debugRow(1)] });
    await repo.updateWhere('DebugItem', [id(1)], { title: 'New' }, { touchUpdatedAt: true });
    expect(rowsOf('debug_items').get(id(1))).toMatchObject({
      title: 'New',
      updated_at: NOW.toISOString(),
    });
    expect(repo.changes()[0]?.row).toMatchObject({ title: 'New' });
  });

  it('an empty patch writes no column and logs one U per row with the stored row', async () => {
    const { repo, statements, rowsOf } = fakeDb({ debug_items: [debugRow(2), debugRow(1)] });
    const before = structuredClone([...rowsOf('debug_items').values()]);
    await repo.updateWhere('DebugItem', [id(2), id(1)], {}, { touchUpdatedAt: true });
    expect(kinds(statements)).toEqual(['select "id",']);
    expect(statements[0]?.text).toMatch(/for update$/);
    expect([...rowsOf('debug_items').values()]).toEqual(before);
    const row = (n: number) => ({
      id: id(n),
      title: `Item ${n}`,
      counter: n,
      syncGroups: ['workspace'],
      archivedAt: null,
    });
    expect(repo.changes()).toEqual([
      { action: 'U', model: 'DebugItem', id: id(1), row: row(1), groups: ['workspace'] },
      { action: 'U', model: 'DebugItem', id: id(2), row: row(2), groups: ['workspace'] },
    ]);
  });

  it('locks and updates at most 5,000 rows per statement, ascending across chunks', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => debugRow(10_001 - i));
    const { repo, statements } = fakeDb({ debug_items: rows });
    const ids = rows.map((row) => String(row['id']));
    await repo.updateWhere('DebugItem', ids, { counter: 1 }, { touchUpdatedAt: false });
    expect(kinds(statements)).toEqual([
      'select "id",',
      'update "debug_items"',
      'select "id",',
      'update "debug_items"',
      'select "id",',
      'update "debug_items"',
    ]);
    const locked = statements
      .filter((s) => s.text.startsWith('select'))
      .map((s) => s.params[0] as string[]);
    expect(locked.map((chunk) => chunk.length)).toEqual([5_000, 5_000, 1]);
    expect(locked.flat()).toEqual(ascendingIds(ids));
    expect(logged(repo.changes())).toEqual(ascendingIds(ids).map((rowId) => `U ${rowId}`));
  });

  it('refuses a patch that touches a field the groups derive from, before any statement', async () => {
    const { repo, statements } = fakeDb({ labels: [] });
    await expect(
      repo.updateWhere('Label', [id(1)], { teamId: id(9) }, { touchUpdatedAt: false }),
    ).rejects.toThrow("updateWhere on Label can't change teamId");
    await expect(
      repo.updateWhere('Team', [id(1)], { private: true }, { touchUpdatedAt: false }),
    ).rejects.toThrow("can't change private");
    expect(statements).toEqual([]);
    expect(updateWhereProblem('DebugItem', { syncGroups: [] })).toMatch(/can't change syncGroups/);
    expect(updateWhereProblem('Label', { name: 'x', parentId: null })).toBeUndefined();
  });

  it('refuses archivedAt: archive state travels as A and V packets (SPEC-011 §5.5)', async () => {
    const { repo, statements } = fakeDb({ debug_items: [debugRow(1)] });
    await expect(
      repo.updateWhere('DebugItem', [id(1)], { archivedAt: NOW }, { touchUpdatedAt: false }),
    ).rejects.toThrow("updateWhere on DebugItem can't change archivedAt");
    expect(updateWhereProblem('Label', { archivedAt: null })).toMatch(/can't change archivedAt/);
    expect(statements).toEqual([]);
  });

  it('treats a patch whose values are all undefined as empty: no update, one U per row', async () => {
    const { repo, statements } = fakeDb({ debug_items: [debugRow(1)] });
    await repo.updateWhere('DebugItem', [id(1)], { title: undefined }, { touchUpdatedAt: true });
    expect(kinds(statements)).toEqual(['select "id",']);
    expect(logged(repo.changes())).toEqual([`U ${id(1)}`]);
  });
});

describe('repo.deleteWhere', () => {
  it('deletes and logs one D per row, in ascending id, with the row’s groups', async () => {
    const handle = fakeDb({
      debug_items: [debugRow(2, ['team:a']), debugRow(1), debugRow(3)],
    });
    const { repo, rowsOf } = handle;
    const { statements } = handle;
    const deleted = await repo.deleteWhere('DebugItem', 'id', [id(2), id(1), id(8)]);
    expect(deleted).toEqual([id(1), id(2)]);
    expect(kinds(statements)).toEqual(['select "id"', 'delete from']);
    expect(statements[0]?.text).toMatch(/order by "debug_items"\."id" asc for update$/);
    expect(statements[1]?.params).toEqual([[id(1), id(2)]]);
    expect(repo.changes()).toEqual([
      { action: 'D', model: 'DebugItem', id: id(1), groups: ['workspace'] },
      { action: 'D', model: 'DebugItem', id: id(2), groups: ['team:a'] },
    ]);
    expect([...rowsOf('debug_items').keys()]).toEqual([id(3)]);
  });

  it('refuses a column that is not a uuid column of the model', async () => {
    const { repo } = fakeDb();
    await expect(repo.deleteWhere('DebugItem', 'title', [id(1)])).rejects.toThrow(
      'column title is not a uuid',
    );
  });

  it('refuses log: false for an eager model, before deleting anything', async () => {
    const { repo, statements } = fakeDb({ debug_items: [debugRow(1)] });
    await expect(repo.deleteWhere('DebugItem', 'id', [id(1)], { log: false })).rejects.toThrow(
      'DebugItem is not a content model',
    );
    expect(statements).toEqual([]);
    expect(repo.unloggedDeletes()).toEqual([]);
  });
});

describe('repo.flush', () => {
  it('logs in chunks of at most 5,000 rows under one lock and one sync_state bump', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => debugRow(i + 1));
    const { repo, statements } = fakeDb({ debug_items: rows });
    await repo.updateWhere(
      'DebugItem',
      rows.map((row) => String(row['id'])),
      {},
      { touchUpdatedAt: false },
    );
    statements.length = 0;
    const flushed = await repo.flush({});
    expect(kinds(statements)).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'update "sync_state"',
      'insert into',
      'insert into',
      'insert into',
    ]);
    const perInsert = statements.slice(2).map((s) => s.params.length / 8);
    expect(perInsert).toEqual([5_000, 5_000, 1]);
    // Contiguous ids, the last one returned.
    const syncIds = statements.slice(2).flatMap((s) => s.params.filter((_, i) => i % 8 === 0));
    expect(syncIds).toEqual(Array.from({ length: 10_001 }, (_, i) => 101 + i));
    expect(flushed.lastSyncId).toBe(10_101);
  });

  it('takes no lock when nothing changed', async () => {
    const { repo, statements } = fakeDb();
    expect(await repo.flush({})).toEqual({});
    expect(statements).toEqual([]);
  });
});

describe('the unlogged content delete (ADR-0022)', () => {
  const shapes: Record<string, ModelShape> = {
    Issue: { load: 'eager' },
    IssueContent: { load: 'content', parent: { model: 'Issue', field: 'issueId' } },
    Orphan: { load: 'content' },
  };
  const shapeOf = (model: string): ModelShape | undefined => shapes[model];
  const purge = (parentIds: string[]) => ({
    model: 'IssueContent',
    field: 'issueId',
    parentIds,
    ids: [id(50)],
  });
  const removed = (...keys: [string, string][]) =>
    new Set(keys.map(([model, rowId]) => removedKey(model, rowId)));

  it('passes when every parent is deleted with a logged D in the same transaction', () => {
    expect(
      unloggedDeleteProblem(
        [purge([id(1), id(2)])],
        removed(['Issue', id(2)], ['Issue', id(1)]),
        shapeOf,
      ),
    ).toBeUndefined();
  });

  it('fails when a parent is not among the rows the transaction removed', () => {
    expect(unloggedDeleteProblem([purge([id(1), id(2)])], removed(['Issue', id(1)]), shapeOf)).toBe(
      `deleteWhere(IssueContent, { log: false }) refused: parent Issue ${id(2)} is not deleted with a logged D in this transaction (ADR-0022).`,
    );
    expect(unloggedDeleteProblem([purge([id(1)])], removed(), shapeOf)).toMatch(/is not deleted/);
    // A removed row of another model with the same id is not the parent.
    expect(unloggedDeleteProblem([purge([id(1)])], removed(['Label', id(1)]), shapeOf)).toMatch(
      /is not deleted/,
    );
  });

  it('fails for an eager model, a content model without a parent, or the wrong field', () => {
    const eager = { ...purge([id(1)]), model: 'Issue', field: 'id' };
    expect(unloggedDeleteProblem([eager], removed(['Issue', id(1)]), shapeOf)).toMatch(
      /Issue is not a content model/,
    );
    const orphan = { ...purge([id(1)]), model: 'Orphan' };
    expect(unloggedDeleteProblem([orphan], removed(['Issue', id(1)]), shapeOf)).toMatch(
      /declares no parent/,
    );
    const wrongField = { ...purge([id(1)]), field: 'id' };
    expect(unloggedDeleteProblem([wrongField], removed(['Issue', id(1)]), shapeOf)).toMatch(
      /must match on the parent field issueId/,
    );
  });

  describe('through the repo, with Label standing in for a content model of DebugItem', () => {
    // No production model is a content model before S5a, so the repo gets a stand-in shape.
    const asContent = (model: string): ModelShape | undefined =>
      model === 'Label'
        ? { load: 'content', parent: { model: 'DebugItem', field: 'parentId' } }
        : modelShape(model);
    const label = (n: number, parent: number): Row => ({
      id: id(n),
      parent_id: id(parent),
      name: `L${n}`,
      sync_groups: ['workspace'],
    });
    const setup = () =>
      fakeDb(
        {
          debug_items: [debugRow(1), debugRow(2)],
          labels: [label(11, 1), label(12, 1), label(21, 2)],
        },
        { shapeOf: asContent },
      );

    it('logs nothing for the content rows when their parent is purged in the transaction', async () => {
      const { repo, rowsOf } = setup();
      expect(await repo.deleteWhere('Label', 'parentId', [id(1)], { log: false })).toEqual([
        id(11),
        id(12),
      ]);
      await repo.purge('DebugItem', id(1));
      await expect(repo.flush({})).resolves.toMatchObject({ lastSyncId: 101 });
      expect(logged(repo.changes())).toEqual([`D ${id(1)}`]);
      expect([...rowsOf('labels').keys()]).toEqual([id(21)]);
      expect(repo.unloggedDeletes()).toEqual([
        { model: 'Label', field: 'parentId', parentIds: [id(1)], ids: [id(11), id(12)] },
      ]);
    });

    it('accepts a parent deleted by a logged deleteWhere', async () => {
      const { repo } = setup();
      await repo.deleteWhere('Label', 'parentId', [id(1), id(2)], { log: false });
      await repo.deleteWhere('DebugItem', 'id', [id(1), id(2)]);
      await expect(repo.flush({})).resolves.toMatchObject({ lastSyncId: 102 });
    });

    it('fails the flush when nothing else changed, before its early return', async () => {
      const { repo, statements } = setup();
      await repo.deleteWhere('Label', 'parentId', [id(1)], { log: false });
      statements.length = 0;
      await expect(repo.flush({})).rejects.toThrow(
        `parent DebugItem ${id(1)} is not deleted with a logged D in this transaction`,
      );
      expect(statements).toEqual([]);
    });

    it('fails when the parent only changed groups: its D+U pair is not a delete (B1)', async () => {
      const { repo } = setup();
      await repo.deleteWhere('Label', 'parentId', [id(1)], { log: false });
      await repo.update('DebugItem', id(1), { syncGroups: ['team:b'] });
      expect(logged(repo.changes())).toEqual([`D ${id(1)}`, `U ${id(1)}`]);
      await expect(repo.flush({})).rejects.toThrow(`parent DebugItem ${id(1)} is not deleted`);
    });

    it('fails when the parent is purged and then inserted again', async () => {
      const { repo } = setup();
      await repo.deleteWhere('Label', 'parentId', [id(1)], { log: false });
      await repo.purge('DebugItem', id(1));
      await repo.insert('DebugItem', { id: id(1), title: 'Again', syncGroups: ['workspace'] });
      await expect(repo.flush({})).rejects.toThrow(`parent DebugItem ${id(1)} is not deleted`);
    });

    it('fails when another parent was purged, not this one', async () => {
      const { repo } = setup();
      await repo.deleteWhere('Label', 'parentId', [id(1)], { log: false });
      await repo.purge('DebugItem', id(2));
      await expect(repo.flush({})).rejects.toThrow(`parent DebugItem ${id(1)} is not deleted`);
    });
  });

  it('reads each synced model’s shape from its definition: no content model before S5a', () => {
    // So every `log: false` is refused at the call until PLAN-011 S5a declares content models
    // with a parent; S5a's tests then run the flush assertion through the repo.
    for (const model of Object.keys(SYNCED_MODELS)) {
      expect(modelShape(model)).toEqual({ load: 'eager' });
    }
    expect(modelShape('Nope')).toBeUndefined();
  });
});
