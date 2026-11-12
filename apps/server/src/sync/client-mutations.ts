/**
 * Exactly-once for sync clients (SPEC-002 §4.4, sync-protocol §4.4): `client_mutations` holds, per
 * `clientId`, its owner, the last seq processed and the results of the last `KEPT_RESULTS` seqs.
 *
 * Each mutation's own transaction locks its client's row first (`claimSeq`), so two requests
 * resending the same seq run one after the other: the second waits, then replays what the first
 * recorded. `recordResult` writes the outcome in that same transaction, so the record is never out
 * of step with the change. Lock order: the client row, then `SYNC_LOCK` (taken by the repo flush);
 * nothing else locks `client_mutations`.
 */
import { mutationResultSchema, type MutationResult } from '@surface/sync-protocol';
import type { Logger } from 'pino';
import type { Queryable } from '../db/pool.js';

/**
 * Results kept for replay: a batch holds at most 100 mutations (`MAX_MUTATIONS_PER_BATCH`), so a
 * resent batch always finds all of its results (SPEC-002 Q11).
 */
export const KEPT_RESULTS = 100;

export type SeqClaim =
  /** `seq` is `last_seq + 1`: run it. */
  | { readonly kind: 'next' }
  /** Processed before: its stored result, without running it again. */
  | { readonly kind: 'replay'; readonly result: MutationResult }
  /** `seq` is past `last_seq + 1`: the client resends from `lastSeq + 1`. */
  | { readonly kind: 'gap'; readonly lastSeq: number }
  /** The `clientId` was registered by another user. */
  | { readonly kind: 'foreign' };

interface LedgerRow {
  user_id: string;
  last_seq: string;
  stored: unknown;
}

const LOCK_ROW = `
  SELECT user_id::text AS user_id, last_seq::text AS last_seq,
    (SELECT e FROM jsonb_array_elements(last_results) AS e WHERE e->>'seq' = $2) AS stored
  FROM client_mutations WHERE client_id = $1 FOR UPDATE`;

/**
 * A `clientId` another user registered: `403` on mutate and the socket. Since SPEC-002 E14 it comes
 * only when the request's `userId` is the session's user, so the queue is this user's own and a
 * new `clientId` is safe: the `userId` check, not this message, keeps a queue under its user.
 * Signing in as the owner wouldn't help: the `userId` check would answer `401`.
 */
export const FOREIGN_CLIENT_MESSAGE =
  "This clientId belongs to another user. Use a new clientId for this user's changes.";

/** Locks the client's row for this transaction (registering it on first use) and places `seq`. */
export async function claimSeq(
  db: Queryable,
  origin: { readonly clientId: string; readonly userId: string; readonly seq: number },
  log?: Logger,
): Promise<SeqClaim> {
  const { clientId, userId, seq } = origin;
  const params = [clientId, String(seq)];
  let row = (await db.query<LedgerRow>(LOCK_ROW, params)).rows[0];
  if (row === undefined) {
    // First use registers the client to this user. A concurrent first use waits on this insert,
    // then finds the row the other one committed.
    await db.query(
      `INSERT INTO client_mutations (client_id, user_id, last_seq, last_results, updated_at)
       VALUES ($1, $2, 0, '[]'::jsonb, now()) ON CONFLICT (client_id) DO NOTHING`,
      [clientId, userId],
    );
    row = (await db.query<LedgerRow>(LOCK_ROW, params)).rows[0];
    if (row === undefined) throw new Error('client_mutations row missing right after its insert');
  }
  if (row.user_id !== userId) return { kind: 'foreign' };
  const lastSeq = Number(row.last_seq);
  if (seq <= lastSeq) {
    if (row.stored === null) return { kind: 'replay', result: forgotten(seq) };
    const stored = mutationResultSchema.safeParse(row.stored);
    if (stored.success && stored.data.seq === seq) return { kind: 'replay', result: stored.data };
    // Throwing here would fail the request, and the client would resend it forever.
    log?.error({ clientId, seq }, 'stored mutation result is unreadable; answered as forgotten');
    return { kind: 'replay', result: forgotten(seq) };
  }
  if (seq > lastSeq + 1) return { kind: 'gap', lastSeq };
  return { kind: 'next' };
}

/** Records `result` as the client's latest seq, keeping the results of the last `KEPT_RESULTS`. */
export async function recordResult(
  db: Queryable,
  clientId: string,
  result: MutationResult,
): Promise<void> {
  await db.query(
    `UPDATE client_mutations SET
       last_seq = $2,
       last_results = (
         SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'seq')::bigint), '[]'::jsonb)
         FROM jsonb_array_elements(last_results || jsonb_build_array($3::jsonb)) AS e
         WHERE (e->>'seq')::bigint > $2::bigint - $4::int),
       updated_at = now()
     WHERE client_id = $1`,
    [clientId, result.seq, JSON.stringify(result), KEPT_RESULTS],
  );
}

/** The user who registered `clientId`, or `undefined` for a client that has sent nothing yet. */
export async function clientOwner(db: Queryable, clientId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ user_id: string }>(
    'SELECT user_id::text AS user_id FROM client_mutations WHERE client_id = $1',
    [clientId],
  );
  return rows[0]?.user_id;
}

/**
 * The newest `sync_id` the actor's connection receives: a row in one of its groups, of a model this
 * server syncs, or 0 when there is none. A mutation that changed no row is confirmed there
 * (SPEC-002 §4.4): the client's `lastSyncId` moves only on rows it receives, so the global head
 * could be out of its reach for good, and no ack comes for a mutation that logged nothing. Every
 * row another client committed that this client would see has an id at or below it, so a value
 * set meanwhile never flickers back. The primary key is walked backwards to the first match.
 */
export async function visibleHead(
  db: Queryable,
  scope: { readonly groups: readonly string[]; readonly models: readonly string[] },
): Promise<number> {
  const { rows } = await db.query<{ sync_id: string }>(
    `SELECT sync_id::text AS sync_id FROM sync_log
     WHERE groups && $1::text[] AND model = ANY($2::text[])
     ORDER BY sync_id DESC LIMIT 1`,
    [scope.groups, scope.models],
  );
  return rows[0] === undefined ? 0 : Number(rows[0].sync_id);
}

/**
 * A seq processed so long ago that its result is no longer kept. A client that follows the
 * protocol never asks: it resends only its current batch (SPEC-002 Q11).
 */
function forgotten(seq: number): MutationResult {
  return {
    seq,
    status: 'error',
    error: {
      code: 'CONFLICT',
      message: `Change ${seq} was already processed and its result is no longer kept. Reload to see the current state.`,
    },
  };
}
