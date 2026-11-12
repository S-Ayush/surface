/**
 * Paging for `status.list`'s default order (SPEC-010 §6): category order, then position, then id.
 * No single column gives that order, so the handler sorts the team's statuses (at most 50) and
 * cuts them after a keyset cursor, the last row's (category rank, position, id), opaque like
 * SPEC-003 §7.1's. A status added or removed between two pages never repeats or skips another.
 */
import {
  comparePositions,
  sortStatuses,
  statusCategoryRank,
  type PositionedStatus,
} from '@surface/domain';
import { z } from 'zod';
import { SurfaceError } from '../../executor/errors.js';

const Cursor = z.tuple([z.int().min(0), z.string(), z.string()]);
type CursorKey = z.infer<typeof Cursor>;

function encode(row: PositionedStatus): string {
  const key: CursorKey = [statusCategoryRank(row.category), row.position, row.id];
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decode(cursor: string): CursorKey {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new SurfaceError('INVALID_INPUT', 'Use the endCursor of the previous page as cursor.', {
      issues: [{ path: ['cursor'], message: 'Not a cursor of this list' }],
    });
  }
}

/** Whether `row` sorts after the cursor's row in display order. */
function after(row: PositionedStatus, [rank, position, id]: CursorKey): boolean {
  return (
    (statusCategoryRank(row.category) - rank ||
      comparePositions(row.position, position) ||
      comparePositions(row.id, id)) > 0
  );
}

export interface StatusPage<T> {
  readonly nodes: T[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export function pageStatuses<T extends PositionedStatus>(
  statuses: readonly T[],
  limit: number,
  cursor: string | undefined,
): StatusPage<T> {
  const sorted = sortStatuses(statuses);
  const key = cursor === undefined ? undefined : decode(cursor);
  const rest = key === undefined ? sorted : sorted.filter((row) => after(row, key));
  const nodes = rest.slice(0, limit);
  const last = nodes.at(-1);
  return {
    nodes,
    hasNextPage: rest.length > nodes.length,
    endCursor: last === undefined ? null : encode(last),
  };
}
