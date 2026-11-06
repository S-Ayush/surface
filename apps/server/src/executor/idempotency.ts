/**
 * `clientMutationId` idempotency for API and MCP mutations (SPEC-003 §9, AC-8). Sync clients use
 * `(clientId, seq)` instead (SPEC-002).
 *
 * The mutation's transaction claims `(actor, id)` first. A concurrent repeat blocks on that row
 * until the first transaction ends: after a commit it replays the stored result, after a
 * rollback it claims the id itself. So a mutation runs at most once per id, without locks
 * beyond the row's own.
 */
import type { Actor } from '@surface/domain';
import { MAX_CLIENT_MUTATION_ID_LENGTH } from '@surface/operations';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queryable } from '../db/pool.js';
import { SurfaceError } from './errors.js';

export const IDEMPOTENCY_TTL_HOURS = 24;

export interface StoredResult {
  readonly result: unknown;
  readonly lastSyncId: number | undefined;
}

export type Claim = { readonly claimed: true } | { readonly replay: StoredResult };

/** Who the id belongs to, or `undefined` for actors without one (system). */
export function idempotencyOwner(actor: Actor): string | undefined {
  if (actor.apiKey) return `key:${actor.apiKey.id}`;
  return actor.userId === undefined ? undefined : `user:${actor.userId}`;
}

export function checkClientMutationId(id: string): void {
  if (id.length === 0 || id.length > MAX_CLIENT_MUTATION_ID_LENGTH) {
    const message = `clientMutationId must be 1–${MAX_CLIENT_MUTATION_ID_LENGTH} characters. Use a UUID.`;
    throw new SurfaceError('INVALID_INPUT', message, {
      issues: [{ path: ['clientMutationId'], message }],
    });
  }
}

/** Claims the id for this transaction, or returns the result stored by an earlier one. */
export async function claim(
  tx: NodePgDatabase,
  owner: string,
  clientMutationId: string,
  operation: string,
): Promise<Claim> {
  // Insert, or take over an expired entry. A fresh entry from another transaction makes this
  // wait for it, then return no row.
  const claimed = await tx.execute(sql`
    INSERT INTO api_idempotency (actor_id, client_mutation_id, operation)
    VALUES (${owner}, ${clientMutationId}, ${operation})
    ON CONFLICT (actor_id, client_mutation_id) DO UPDATE
      SET operation = excluded.operation, result = NULL, last_sync_id = NULL, created_at = now()
      WHERE api_idempotency.created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})
    RETURNING 1`);
  if (claimed.rows.length > 0) return { claimed: true };

  const { rows } = await tx.execute<{
    operation: string;
    result: unknown;
    last_sync_id: string | null;
  }>(sql`
    SELECT operation, result, last_sync_id FROM api_idempotency
    WHERE actor_id = ${owner} AND client_mutation_id = ${clientMutationId}`);
  const stored = rows[0];
  if (stored === undefined) {
    // Expired and pruned between the two statements: rare enough to ask for a retry.
    throw new SurfaceError('CONFLICT', 'This change was retried at the same time. Try again.');
  }
  if (stored.operation !== operation) {
    const message = `clientMutationId "${clip(clientMutationId)}" was already used for ${stored.operation}. Use a new id for each change.`;
    throw new SurfaceError('INVALID_INPUT', message, {
      issues: [{ path: ['clientMutationId'], message }],
    });
  }
  return {
    replay: {
      result: stored.result,
      lastSyncId: stored.last_sync_id === null ? undefined : Number(stored.last_sync_id),
    },
  };
}

/** Stores the result in the claiming transaction, so it commits with the change. */
export async function record(
  tx: NodePgDatabase,
  owner: string,
  clientMutationId: string,
  result: unknown,
  lastSyncId: number | undefined,
): Promise<void> {
  await tx.execute(sql`
    UPDATE api_idempotency
    SET result = ${JSON.stringify(result)}::json, last_sync_id = ${lastSyncId ?? null}
    WHERE actor_id = ${owner} AND client_mutation_id = ${clientMutationId}`);
}

/** Deletes expired entries; the `idempotency.prune` job runs it. Returns how many. */
export async function pruneIdempotency(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM api_idempotency WHERE created_at < now() - make_interval(hours => $1)`,
    [IDEMPOTENCY_TTL_HOURS],
  );
  return rowCount ?? 0;
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
