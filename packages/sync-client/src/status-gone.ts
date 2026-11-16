/**
 * SPEC-010 E1: a change queued offline names a status that someone deleted meanwhile. The server
 * answers `NOT_FOUND` (the status was gone before resolution) or `CONFLICT` (it went during the
 * transaction); a deleted status reads there like one that never existed. When this replica has
 * applied the status's `D` delta, the client says what happened instead.
 */
import { isUuid } from '@surface/domain';
import type { DeletedRow } from './store.js';

export const STATUS_GONE_MESSAGE = 'That status was deleted. Choose another.';

/** What the helper reads of the store: the deletes this session applied. */
export interface SeenDeletes {
  seenDeleted(model: string, id: string): DeletedRow | undefined;
  /** Every remembered delete of `model`, for a status named by name. */
  seenDeletedRows?(model: string): readonly DeletedRow[];
}

/**
 * The message to show for a rejected mutation whose input names a `status`: E1's when the
 * rejection is `NOT_FOUND` or `CONFLICT` and the replica has seen that status deleted (by id, or
 * by name among the deleted statuses it remembers), else the server's message unchanged.
 */
export function statusGoneMessage(
  rejection: { readonly code: string; readonly message: string; readonly input: unknown },
  store: SeenDeletes,
): string {
  if (rejection.code !== 'NOT_FOUND' && rejection.code !== 'CONFLICT') return rejection.message;
  const input = rejection.input;
  const status: unknown =
    typeof input === 'object' && input !== null ? Reflect.get(input, 'status') : undefined;
  if (typeof status !== 'string') return rejection.message;
  if (isUuid(status)) {
    return store.seenDeleted('WorkflowStatus', status) ? STATUS_GONE_MESSAGE : rejection.message;
  }
  const wanted = status.trim().toLowerCase();
  const named = (store.seenDeletedRows?.('WorkflowStatus') ?? []).some(
    (row) => row.name?.toLowerCase() === wanted,
  );
  return named ? STATUS_GONE_MESSAGE : rejection.message;
}
