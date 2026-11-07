/**
 * The hub's view of Postgres (SPEC-002 §4.3): the head, ranges of `sync_log`, catch-up a page at a
 * time, and `LISTEN sync`. Behind an interface so the hub's rules are unit-tested
 * against a fake; this file is covered by the integration tests.
 */
import type pg from 'pg';
import { syncGroupSchema } from '@surface/sync-protocol';
import type { LogRow } from './delta-writer.js';
import { SYNC_CHANNEL, type SyncAction } from './repo.js';

export type CatchUpEvent =
  { readonly t: 'rows'; readonly rows: readonly LogRow[] } | { readonly t: 'too_old' };

export interface CatchUpRequest {
  /** The client has everything up to here. */
  readonly since: number;
  /** The hub has delivered everything up to here live; later rows reach the connection live. */
  readonly upTo: number;
  readonly groups: readonly string[];
  readonly clientId: string;
  readonly pageSize: number;
}

export interface Listener {
  /** Resolves when the connection fails or ends; the hub then listens again. */
  readonly ended: Promise<unknown>;
  close(): Promise<void>;
}

export interface SyncLogSource {
  /** `sync_state.last_sync_id`: every row up to it is committed, and it ends a transaction. */
  head(): Promise<number>;
  /** Every row with `after < sync_id ≤ upTo`, in order. */
  read(after: number, upTo: number): Promise<readonly LogRow[]>;
  /**
   * Rows in `(since, upTo]` the connection may see or that its own client wrote (for acks), in
   * pages. `too_old` (and nothing after it) when the log no longer holds every row after the last
   * page (pruned meanwhile), or `since` is ahead of the head (a database restored from a backup).
   * Holds no database connection while the caller waits between pages.
   */
  catchUp(request: CatchUpRequest): AsyncGenerator<CatchUpEvent>;
  listen(onNotify: () => void): Promise<Listener>;
}

/** One statement at a time on any pool connection: a `pg.Pool`, never a checked-out client. */
export interface QueryClient {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface PgSourceOptions {
  /**
   * Only `query`, so a catch-up can't hold a connection while a slow client reads: a pool of 10
   * would otherwise run dry with 10 slow clients, stalling writes and live delivery.
   */
  readonly pool: QueryClient;
  /** A connection of its own for `LISTEN`, held for the hub's life (not a pool slot). */
  readonly listenClient: () => pg.Client;
}

// `sync_id` is read as text (a bigint) under another name: an output column named `sync_id` would
// make `ORDER BY sync_id` sort the text, putting 10 before 9.
const SELECT_ROWS = `SELECT sync_id::text AS id_text, model, model_id, action, data, groups,
  client_id, client_seq::text AS client_seq FROM sync_log`;

// Catch-up also reads the client's own mutations on rows it can't see, for their acks. Their data
// and groups never leave Postgres: the writer then finds no visible group and sends only the ack.
const SELECT_CATCH_UP_ROWS = `SELECT sync_id::text AS id_text, model, model_id, action,
  CASE WHEN groups && $3::text[] THEN data END AS data,
  CASE WHEN groups && $3::text[] THEN groups ELSE '{}'::text[] END AS groups,
  client_id, client_seq::text AS client_seq FROM sync_log`;

export function pgSyncLogSource({ pool, listenClient }: PgSourceOptions): SyncLogSource {
  return {
    head: () => head(pool),

    async read(after, upTo) {
      const { rows } = await pool.query<RawRow>(
        `${SELECT_ROWS} WHERE sync_id > $1 AND sync_id <= $2 ORDER BY sync_id`,
        [after, upTo],
      );
      return rows.map(toLogRow);
    },

    async *catchUp({ since, upTo, groups, clientId, pageSize }) {
      const visible = syncGroupSchema.array().parse(groups);
      for (let after = since; ;) {
        // Every row up to `upTo` is committed (it is at most the head when the hub took it), so
        // each page can be its own short statement; no snapshot needs to span the pages.
        const pageRows =
          after < upTo
            ? (
                await pool.query<RawRow>(
                  `${SELECT_CATCH_UP_ROWS} WHERE sync_id > $1 AND sync_id <= $2
                     AND (groups && $3::text[] OR client_id = $4)
                   ORDER BY sync_id LIMIT $5`,
                  [after, upTo, visible, clientId, pageSize],
                )
              ).rows.map(toLogRow)
            : [];
        // Checked after the read: the prune deletes only a prefix of the log and the oldest id only
        // grows, so if row `after + 1` is still retained now, nothing this page covers was missing
        // when it was read.
        if (!(await retains(pool, since, after))) {
          yield { t: 'too_old' };
          return;
        }
        const lastRow = pageRows.at(-1);
        if (!lastRow) return;
        yield { t: 'rows', rows: pageRows };
        if (pageRows.length < pageSize) return;
        after = lastRow.syncId;
      }
    },

    async listen(onNotify) {
      const client = listenClient();
      const ended = new Promise<unknown>((resolve) => {
        client.on('error', resolve);
        client.on('end', () => resolve(undefined));
      });
      client.on('notification', (message) => {
        if (message.channel === SYNC_CHANNEL) onNotify();
      });
      try {
        await client.connect();
        await client.query(`LISTEN ${SYNC_CHANNEL}`);
      } catch (error) {
        await client.end().catch(() => undefined);
        throw error;
      }
      return { ended, close: () => client.end() };
    },
  };
}

/** Whether the log still holds every row after `after`, and `since` is not ahead of the head. */
async function retains(client: QueryClient, since: number, after: number): Promise<boolean> {
  const { rows } = await client.query<{ last: string | null; oldest: string | null }>(
    `SELECT (SELECT last_sync_id FROM sync_state WHERE id = 1)::text AS last,
            (SELECT min(sync_id) FROM sync_log)::text AS oldest`,
  );
  const last = rows[0]?.last;
  if (last == null) throw new Error('sync_state has no row. Migration 0005 seeds it');
  // `synclog-prune` keeps the newest row, so an empty log means nothing was ever written.
  const oldest = rows[0]?.oldest;
  const retainedFrom = oldest == null ? Number(last) + 1 : Number(oldest);
  return since <= Number(last) && after + 1 >= retainedFrom;
}

async function head(client: QueryClient): Promise<number> {
  const { rows } = await client.query<{ last: string }>(
    'SELECT last_sync_id::text AS last FROM sync_state WHERE id = 1',
  );
  const last = rows[0]?.last;
  if (last === undefined) throw new Error('sync_state has no row. Migration 0005 seeds it');
  return Number(last);
}

interface RawRow extends Record<string, unknown> {
  id_text: string;
  model: string;
  model_id: string;
  action: string;
  data: unknown;
  groups: string[];
  client_id: string | null;
  client_seq: string | null;
}

const ACTIONS: readonly string[] = ['I', 'U', 'A', 'V', 'D'] satisfies SyncAction[];
const isAction = (value: string): value is SyncAction => ACTIONS.includes(value);

function toLogRow(raw: RawRow): LogRow {
  const action = raw.action;
  if (!isAction(action)) throw new Error(`sync_log row ${raw.id_text} has an unknown action`);
  const data = raw.data;
  return {
    syncId: Number(raw.id_text),
    model: raw.model,
    modelId: raw.model_id,
    action,
    data: isRecord(data) ? data : null,
    groups: raw.groups,
    clientId: raw.client_id,
    clientSeq: raw.client_seq === null ? null : Number(raw.client_seq),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
