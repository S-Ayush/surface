// AC-12 (SPEC-002), static half: `surface/no-synced-table-writes` flags writes to synced tables
// outside the repo layer, and its table list covers every synced model. The runtime half is
// the write audit in `test/executor.ts` (`repo-guard.int.test.ts`).
import { SYNCED_TABLES } from '@surface/config/eslint';
import rule from '@surface/config/eslint-rules/no-synced-table-writes';
import { getTableName, type Table } from 'drizzle-orm';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema/index.js';
import { SYNCED_MODELS } from '../src/sync/models.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } });
const options = [{ tables: [{ identifier: 'debugItems', name: 'debug_items' }] }];
const write = [{ messageId: 'write', data: { table: 'debug_items' } }];
const writeSome = [{ messageId: 'write', data: { table: 'a synced table' } }];

tester.run('no-synced-table-writes', rule, {
  valid: [
    { code: 'db.select().from(debugItems)', options },
    { code: 'db.insert(eventOutbox).values({})', options },
    { code: 'db.execute(sql`SELECT * FROM debug_items WHERE id = ${id}`)', options },
    { code: "const s = 'update debug_items_archive set x = 1'", options },
    { code: 'map.delete(key)', options },
    { code: 'db.execute(sql`SELECT * FROM ${debugItems} WHERE id = ${id}`)', options },
    { code: 'db.execute(sql`UPDATE ${otherTable} SET x = 1`)', options },
    { code: "db.execute(sql.raw('update ' + name))", options },
    { code: 'db.update(other.table).set({})', options },
    { code: 'const { groupsOf } = SYNCED_MODELS.DebugItem; groupsOf(row)', options },
  ],
  invalid: [
    { code: 'db.insert(debugItems).values({})', options, errors: write },
    { code: 'tx.update(schema.debugItems).set({ title })', options, errors: write },
    { code: 'db.delete(debugItems).where(cond)', options, errors: write },
    { code: 'db.execute(sql`UPDATE debug_items SET title = ${t}`)', options, errors: write },
    { code: 'db.execute(sql`delete from only "public"."debug_items"`)', options, errors: write },
    { code: "client.query('INSERT INTO debug_items (id) VALUES ($1)')", options, errors: write },
    { code: 'db.execute(sql`TRUNCATE TABLE debug_items`)', options, errors: write },
    // A table interpolated into raw SQL, the usual Drizzle form.
    { code: 'db.execute(sql`UPDATE ${debugItems} SET title = ${t}`)', options, errors: write },
    {
      code: 'db.execute(sql`delete from ${schema.debugItems} where id = ${id}`)',
      options,
      errors: write,
    },
    {
      code: "db.execute(sql`UPDATE ${sql.identifier('debug_items')} SET x = 1`)",
      options,
      errors: write,
    },
    {
      code: 'db.execute(sql`MERGE INTO debug_items USING s ON true WHEN MATCHED THEN DELETE`)',
      options,
      errors: write,
    },
    {
      code: "db.execute(sql.raw('update ' + 'debug_items set title = 1'))",
      options,
      errors: write,
    },
    // Tables taken from SYNCED_MODELS, as the repo itself does, or through an alias.
    { code: 'tx.update(SYNCED_MODELS.DebugItem.table).set({})', options, errors: writeSome },
    { code: 'tx.insert(SYNCED_MODELS[model].table).values({})', options, errors: writeSome },
    {
      code: 'const { table } = SYNCED_MODELS.DebugItem; tx.update(table)',
      options,
      errors: writeSome,
    },
    { code: 'const { table: t } = SYNCED_MODELS[m]; tx.delete(t)', options, errors: writeSome },
    { code: 'const m = SYNCED_MODELS.DebugItem; tx.update(m.table)', options, errors: writeSome },
    {
      code: "import { SYNCED_MODELS as M } from './models.js'; db.update(M.DebugItem.table)",
      options,
      errors: writeSome,
    },
    {
      code: 'db.execute(sql`UPDATE ${SYNCED_MODELS.DebugItem.table} SET x = 1`)',
      options,
      errors: writeSome,
    },
    { code: 'const items = debugItems; db.delete(items)', options, errors: write },
  ],
});

describe('the configured table list', () => {
  const exportName = (table: Table) =>
    Object.entries(schema).find(([, value]) => value === table)?.[0];

  it('covers every synced model and the sync log, by Drizzle export and SQL name', () => {
    const expected = [
      ...Object.values(SYNCED_MODELS).map((m) => m.table),
      schema.syncLog,
      schema.syncState,
    ].map((table) => ({ identifier: exportName(table), name: getTableName(table) }));
    expect([...SYNCED_TABLES].sort(byName)).toEqual(expected.sort(byName));
  });
});

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
