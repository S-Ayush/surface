/**
 * SPEC-010 E1: a change queued offline names a status that someone deleted meanwhile. The server
 * answers `NOT_FOUND` (the status was gone before resolution) or `CONFLICT` on `status` (it went
 * during the transaction); a deleted status reads there like one that never existed. When this
 * replica has applied the status's `D` delta, the client says what happened instead. Only a
 * refusal about the status is reworded: a `CONFLICT` for an archived issue (AC-23) keeps its own
 * words, and a name matches only a status of the team the input names.
 */
import { isUuid } from '@surface/domain';
import type { DeletedRow } from './store.js';

export const STATUS_GONE_MESSAGE = 'That status was deleted. Choose another.';

/** What the helper reads of the store: the deletes this session applied. */
export interface SeenDeletes {
  seenDeleted(model: string, id: string): DeletedRow | undefined;
  /** Every remembered delete of `model`, for a status named by name. */
  seenDeletedRows?(model: string): readonly DeletedRow[];
  /** The id of the team a key names, from the replica; undefined when it holds none. */
  teamIdOf?(key: string): string | undefined;
}

/** The refusal is about the input's `status`, not the issue or another field. */
function aboutStatus(rejection: Rejected): boolean {
  const onStatus = (rejection.issues ?? []).some((issue) => issue.path[0] === 'status');
  if (rejection.code === 'CONFLICT') return onStatus;
  if (rejection.code === 'NOT_FOUND') return onStatus || (rejection.issues ?? []).length === 0;
  return false;
}

type Rejected = {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
  readonly issues?: readonly { readonly path: readonly (string | number)[] }[] | undefined;
};

/**
 * The message to show for a rejected mutation whose input names a `status`: E1's when the
 * rejection is about that status (`NOT_FOUND`, or `CONFLICT` on `status`) and the replica has seen
 * it deleted, else the server's message unchanged. A status id matches a remembered delete by id.
 * A name matches only among the remembered deletes of the team the input's `team` names, so
 * "Review" deleted in ENG never rewords a refusal for OPS; without a `team` a name never matches.
 */
export function statusGoneMessage(rejection: Rejected, store: SeenDeletes): string {
  if (!aboutStatus(rejection)) return rejection.message;
  const input = rejection.input;
  const field = (name: string): unknown =>
    typeof input === 'object' && input !== null ? Reflect.get(input, name) : undefined;
  const status = field('status');
  if (typeof status !== 'string') return rejection.message;
  if (isUuid(status)) {
    return store.seenDeleted('WorkflowStatus', status) ? STATUS_GONE_MESSAGE : rejection.message;
  }
  const team = field('team');
  if (typeof team !== 'string') return rejection.message;
  const teamId = (isUuid(team) ? team : store.teamIdOf?.(team))?.toLowerCase();
  if (teamId === undefined) return rejection.message;
  const wanted = status.trim().toLowerCase();
  const named = (store.seenDeletedRows?.('WorkflowStatus') ?? []).some(
    (row) => row.teamId?.toLowerCase() === teamId && row.name?.toLowerCase() === wanted,
  );
  return named ? STATUS_GONE_MESSAGE : rejection.message;
}
