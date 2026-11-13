/**
 * `GET /sync/bootstrap` (SPEC-002 §4, sync-protocol §4.1): every eager row the actor can see,
 * as NDJSON frames `meta`, `row`…, `end`. Everything is read in one `REPEATABLE READ READ ONLY`
 * transaction, so the rows are exactly the state at `lastSyncId`: the client continues with
 * deltas after it and misses nothing. Rows stream through a server-side cursor, 1,000 per
 * fetch, pulled only as fast as the response is written.
 */
import { syncGroupSchema, type BootstrapFrame } from '@surface/sync-protocol';
import { clientRow, type SyncModel, type SyncRegistry } from './registry.js';

export const BOOTSTRAP_FETCH_SIZE = 1000;

/** What bootstrap needs from a connection: `pg.PoolClient` satisfies it. */
export interface BootstrapClient {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
  release(destroy?: boolean): void;
}

/** What bootstrap needs from the pool: `pg.Pool` satisfies it. */
export interface BootstrapPool {
  connect(): Promise<BootstrapClient>;
}

export interface BootstrapOptions {
  readonly pool: BootstrapPool;
  readonly registry: SyncRegistry;
  /** The actor's sync groups: only rows in one of them are sent (`sync_groups && $groups`). */
  readonly groups: readonly string[];
  readonly now: () => Date;
}

/**
 * The frames of one bootstrap. Holds a pool client until the generator finishes or is closed
 * (the client went away), and always ends the transaction before releasing it.
 */
export async function* bootstrapFrames({
  pool,
  registry,
  groups,
  now,
}: BootstrapOptions): AsyncGenerator<BootstrapFrame> {
  // The actor's groups are the server's own, but `meta` promises wire-valid ones: check first.
  const wireGroups = syncGroupSchema.array().parse(groups);
  const client = await pool.connect();
  let healthy = false;
  try {
    // The snapshot is taken at the first statement; everything below reads that one snapshot.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // `sync_state` moves with `sync_log` in every writing transaction, so it equals
    // max(sync_id) in this snapshot without scanning the log.
    const head = await client.query<{ last: string }>(
      'SELECT last_sync_id AS last FROM sync_state WHERE id = 1',
    );
    const lastSyncId = Number(head.rows[0]?.last ?? 0);
    let total = 0;
    for (const model of registry.eager) {
      const counted = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${quote(model.table)} WHERE sync_groups && $1::text[]`,
        [groups],
      );
      total += Number(counted.rows[0]?.n ?? 0);
    }

    yield {
      t: 'meta',
      schemaHash: registry.schemaHash,
      lastSyncId,
      groups: wireGroups,
      serverTime: now().toISOString(),
      rows: total,
    };

    const visible = new Set(groups);
    let sent = 0;
    for (const model of registry.eager) {
      await client.query(`DECLARE bootstrap NO SCROLL CURSOR FOR ${selectRows(model)}`, [groups]);
      for (;;) {
        const batch = await client.query<Record<string, unknown>>(
          `FETCH ${BOOTSTRAP_FETCH_SIZE} FROM bootstrap`,
        );
        for (const row of batch.rows) {
          sent++;
          yield {
            t: 'row',
            m: model.name,
            d: clientRow(model, row, row[GROUPS_ALIAS], visible),
            ...(row[ARCHIVED_ALIAS] === true ? { archived: true } : {}),
          };
        }
        if (batch.rows.length < BOOTSTRAP_FETCH_SIZE) break;
      }
      await client.query('CLOSE bootstrap');
    }
    if (sent !== total) {
      // Impossible inside one snapshot; if it happens, the client must not trust this stream.
      throw new Error(`bootstrap counted ${total} rows but read ${sent}`);
    }
    yield { t: 'end', rows: sent };
    await client.query('COMMIT');
    healthy = true;
  } finally {
    if (!healthy) {
      // An error or a closed response: end the transaction before the client goes back.
      healthy = await client.query('ROLLBACK').then(
        () => true,
        () => false,
      );
    }
    client.release(!healthy);
  }
}

/**
 * Aliases for the row's groups and archive state. `defineModel` accepts camelCase field names
 * only, so these never collide with a declared field.
 */
export const GROUPS_ALIAS = '__groups';
const ARCHIVED_ALIAS = '__archived';

/**
 * The declared fields under their client names, plus the row's groups and archive state.
 * Exported for tests.
 */
export function selectRows(model: SyncModel): string {
  const fields = [...model.columns].map(([field, column]) =>
    // A calendar date goes out as `YYYY-MM-DD`: `pg` would parse a `date` into a `Date` at the
    // server's local midnight, which `clientRow` would turn into an instant (a due date off by
    // the offset).
    model.def.fields[field]?.kind === 'day'
      ? `${quote(column)}::text AS ${quote(field)}`
      : `${quote(column)} AS ${quote(field)}`,
  );
  // Read even when the model has no `groups` field: cheap, and `clientRow` decides.
  fields.push(`sync_groups AS ${quote(GROUPS_ALIAS)}`);
  fields.push(
    model.archivable
      ? `archived_at IS NOT NULL AS ${quote(ARCHIVED_ALIAS)}`
      : `false AS ${quote(ARCHIVED_ALIAS)}`,
  );
  return `SELECT ${fields.join(', ')} FROM ${quote(model.table)} WHERE sync_groups && $1::text[]`;
}

/** A SQL identifier from the registry (never from input): table and column names. */
export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
