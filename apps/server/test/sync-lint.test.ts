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

tester.run('no-synced-table-writes', rule, {
  valid: [
    { code: 'db.select().from(debugItems)', options },
    { code: 'db.insert(eventOutbox).values({})', options },
    { code: 'db.execute(sql`SELECT * FROM debug_items WHERE id = ${id}`)', options },
    { code: "const s = 'update debug_items_archive set x = 1'", options },
    { code: 'map.delete(key)', options },
  ],
  invalid: [
    { code: 'db.insert(debugItems).values({})', options, errors: write },
    { code: 'tx.update(schema.debugItems).set({ title })', options, errors: write },
    { code: 'db.delete(debugItems).where(cond)', options, errors: write },
    { code: 'db.execute(sql`UPDATE debug_items SET title = ${t}`)', options, errors: write },
    { code: 'db.execute(sql`delete from only "public"."debug_items"`)', options, errors: write },
    { code: "client.query('INSERT INTO debug_items (id) VALUES ($1)')", options, errors: write },
    { code: 'db.execute(sql`TRUNCATE TABLE debug_items`)', options, errors: write },
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
