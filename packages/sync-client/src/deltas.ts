/**
 * Delta apply (SPEC-002 §3.4, E1, E2): decide what a `deltas` message means
 * for this replica, and turn its packets into pool and storage changes.
 *
 * - `prev > lastSyncId`: packets were missed (E1). Nothing is applied; the
 *   caller reconnects with `since = lastSyncId`.
 * - Otherwise, packets with `id ≤ lastSyncId` are duplicates and are skipped
 *   (E2). The rest are contiguous with what was applied, because a message
 *   covers the connection's stream from `prev` onwards.
 * - A `G` packet (sync groups changed) means a full re-bootstrap until M7.
 *
 * Every row is validated before anything is applied, so a message is all or
 * nothing.
 */
import type { DeltaPacket, DeltasMessage } from '@surface/sync-protocol';
import { ProtocolError } from '@surface/sync-protocol';
import { decodeRow } from './bootstrap.js';
import type { BaseChange, ObjectPool } from './pool.js';
import type { StoredChange } from './storage/types.js';

/** What an applied packet changed, without the row (the inspector, SPEC-002 §5.4). */
export interface AppliedPacket {
  readonly id: number;
  readonly action: 'I' | 'U' | 'A' | 'V' | 'D';
  readonly model: string;
  readonly rowId: string;
}

export type DeltaPlan =
  | { readonly kind: 'gap' }
  | { readonly kind: 'resync' }
  /** Nothing new: every packet was a duplicate, or the message only carries acks. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'apply';
      readonly base: readonly BaseChange[];
      readonly stored: readonly StoredChange[];
      /** The id of the last packet applied: the new `lastSyncId`. */
      readonly lastSyncId: number;
      /** In packet order. */
      readonly applied: readonly AppliedPacket[];
    };

/** Throws `ProtocolError` when a row does not match its model. */
export function planDeltas(
  pool: ObjectPool,
  message: DeltasMessage,
  lastSyncId: number,
): DeltaPlan {
  if (message.prev > lastSyncId) return { kind: 'gap' };
  const fresh = message.packets.filter((packet) => packet.id > lastSyncId);
  const last = fresh.at(-1);
  if (last === undefined) return { kind: 'none' };
  if (fresh.some((packet) => packet.a === 'G')) return { kind: 'resync' };

  const base: BaseChange[] = [];
  const stored: StoredChange[] = [];
  const applied: AppliedPacket[] = [];
  for (const packet of fresh) {
    const change = toChange(pool, packet);
    if (change === undefined) continue;
    base.push(change.base);
    stored.push(change.stored);
    applied.push(change.applied);
  }
  return { kind: 'apply', base, stored, lastSyncId: last.id, applied };
}

function toChange(
  pool: ObjectPool,
  packet: DeltaPacket,
): { base: BaseChange; stored: StoredChange; applied: AppliedPacket } | undefined {
  const version = packet.id;
  switch (packet.a) {
    case 'I':
    case 'U':
    case 'A':
    case 'V': {
      // A and V carry the full row (v0.7, SPEC-011 §5.5): an upsert plus the flag.
      const kind = packet.a === 'A' ? 'archive' : packet.a === 'V' ? 'unarchive' : 'upsert';
      const row = decodeRow(pool, packet.m, packet.d);
      return {
        base: { kind, model: packet.m, row },
        stored: { kind, model: packet.m, version, row },
        applied: { id: packet.id, action: packet.a, model: packet.m, rowId: row.id },
      };
    }
    case 'D': {
      if (!pool.models.some((def) => def.name === packet.m)) {
        throw new ProtocolError(`Invalid packet: unknown model ${packet.m}`);
      }
      return {
        base: { kind: 'delete', model: packet.m, id: packet.mid },
        stored: { kind: 'delete', model: packet.m, version, id: packet.mid },
        applied: { id: packet.id, action: packet.a, model: packet.m, rowId: packet.mid },
      };
    }
    case 'G':
      return undefined;
  }
}
