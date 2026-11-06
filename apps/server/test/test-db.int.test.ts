// The per-file test database helper itself. `pg.Pool#end()` resolves before its sockets close,
// so a drop right after it can catch connections still closing. Terminating those surfaced as
// unhandled FATAL 57P01 errors in whichever test file was running.
import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase, withAdmin } from './db.js';

it('waits for connections that are still closing before dropping the database', async () => {
  const db = await createTestDatabase({ migrated: false });
  const client = new pg.Client({ connectionString: db.url });
  const errors: Error[] = [];
  client.on('error', (error) => errors.push(error));
  await client.connect();

  const dropping = db.drop();
  // Close only after the drop has started: a race created on purpose.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await client.end();
  await dropping;

  expect(errors.map((e) => e.message)).toEqual([]);
  const { rowCount } = await withAdmin((admin) =>
    admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name]),
  );
  expect(rowCount).toBe(0);
});
