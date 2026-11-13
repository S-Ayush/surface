/**
 * Stand-in Postgres connections for unit tests of the repo and its helpers (no Docker). Drizzle
 * builds the real SQL; these answer it.
 *
 * - `scriptedDb` keeps rows per table (keyed by DB column) and answers the single-table
 *   statements the repo sends: select, insert, update and delete, each with a `where` on one
 *   column by `= $n` or `= ANY($n::uuid[])`, with `for update` or `for share`; plus the sync lock,
 *   `sync_state` and `sync_log`. (PLAN-011 S1, moved here in S3.)
 * - `recordingDb` answers each statement with whatever `answer` returns, for helpers whose SQL is
 *   more than one table or one condition.
 *
 * Both record every statement with its parameters, in order.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { syncRepo, type SyncRepoOptions, type TransactionRepo } from '../../src/sync/repo.js';

export type Row = Record<string, unknown>;

export interface Statement {
  readonly text: string;
  readonly params: unknown[];
}

/** The quoted column names of a `select …`/`returning …` list, in order. */
function columnList(list: string): string[] {
  return list.split(',').map((item) => {
    const names = [...item.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? '');
    return names.at(-1) ?? item.trim();
  });
}

export interface ScriptedDb {
  readonly db: NodePgDatabase;
  readonly repo: TransactionRepo;
  readonly statements: Statement[];
  readonly rowsOf: (table: string) => Map<string, Row>;
}

export function scriptedDb(
  seed: Record<string, Row[]> = {},
  { now, ...options }: SyncRepoOptions & { readonly now: Date },
): ScriptedDb {
  const tables = new Map<string, Map<string, Row>>();
  for (const [table, rows] of Object.entries(seed)) {
    tables.set(table, new Map(rows.map((row) => [String(row['id']), { ...row }])));
  }
  const statements: Statement[] = [];
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
        /^select (.*?) from "(\w+)" where (.*?)( order by "\w+"\."id" asc)?( for (?:update|share))?$/.exec(
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
  const repo = syncRepo(db, now, options);
  return { db, repo, statements, rowsOf };
}

/**
 * A connection that answers every statement with `answer(text, params)`: rows as arrays of
 * column values for Drizzle's builder queries (in the selected or returned columns' order).
 */
export function recordingDb(answer: (text: string, params: unknown[]) => unknown[][] = () => []): {
  readonly db: NodePgDatabase;
  readonly statements: Statement[];
} {
  const statements: Statement[] = [];
  const client = {
    query(config: { text: string }, params: unknown[] = []) {
      statements.push({ text: config.text, params });
      const rows = answer(config.text, params);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { db: drizzle({ client: client as never, casing: 'snake_case' }), statements };
}
