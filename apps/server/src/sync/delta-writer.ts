/**
 * One connection's view of `sync_log` (SPEC-002 §4.3, sync-protocol §4.3): rows in, `deltas`
 * messages out. Pure, so the batching rules are unit-tested without a socket or a database.
 *
 * - Only rows whose groups meet the connection's are sent, with their groups cut to the
 *   connection's (Q6). Rows of models the registry doesn't know are skipped.
 * - `prev` is the id of the last packet sent on this connection (`since` at first).
 * - At most 500 packets per message, and a `D` is never the last packet of a message when the
 *   next packet is for the same row, so a groups change (Q5) arrives as one unit.
 * - Acks for this connection's own mutations are sent only at a transaction boundary, after every
 *   packet of the range: a client that confirms a mutation has all of its visible changes.
 */
import {
  MAX_PACKETS_PER_MESSAGE,
  type Ack,
  type DeltaPacket,
  type DeltasMessage,
} from '@surface/sync-protocol';
import { clientRow, type SyncModel } from './registry.js';
import type { SyncAction } from './repo.js';

/** A `sync_log` row as the hub reads it. */
export interface LogRow {
  readonly syncId: number;
  readonly model: string;
  readonly modelId: string;
  readonly action: SyncAction;
  /** The full row (camelCase fields, `syncGroups` included) for I/U/A/V; null for D (Q4). */
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly groups: readonly string[];
  readonly clientId: string | null;
  readonly clientSeq: number | null;
}

/** The packet `row` becomes for a connection in `visible`, or undefined if it sees nothing. */
export function toPacket(
  models: ReadonlyMap<string, SyncModel>,
  row: LogRow,
  visible: ReadonlySet<string>,
): DeltaPacket | undefined {
  const model = models.get(row.model);
  if (!model || !row.groups.some((g) => visible.has(g))) return undefined;
  switch (row.action) {
    case 'I':
    case 'U': {
      if (row.data === null) return undefined;
      const d = clientRow(model, row.data, row.data['syncGroups'], visible);
      return { id: row.syncId, a: row.action, m: row.model, d };
    }
    case 'A':
    case 'V':
    case 'D':
      return { id: row.syncId, a: row.action, m: row.model, mid: row.modelId };
  }
}

export interface DeltaWriterOptions {
  readonly models: ReadonlyMap<string, SyncModel>;
  readonly groups: ReadonlySet<string>;
  readonly clientId: string;
  /** The connection's `since`: rows up to it are already on the client. */
  readonly since: number;
  readonly send: (message: DeltasMessage) => void;
}

export class DeltaWriter {
  readonly #options: DeltaWriterOptions;
  #prev: number;
  /** The highest sync id taken in, visible or not, so a row is never taken twice. */
  #through: number;
  #packets: DeltaPacket[] = [];
  #acks: Ack[] = [];
  #lastAckSeq: number | undefined;

  constructor(options: DeltaWriterOptions) {
    this.#options = options;
    this.#prev = options.since;
    this.#through = options.since;
  }

  /** The id of the last packet sent (the next message's `prev`). */
  get prev(): number {
    return this.#prev;
  }

  /** The highest sync id taken in so far. */
  get through(): number {
    return this.#through;
  }

  /** Takes in rows in sync-id order. Rows at or below `through` are skipped. */
  add(rows: readonly LogRow[]): void {
    const { models, groups, clientId } = this.#options;
    for (const row of rows) {
      if (row.syncId <= this.#through) continue;
      this.#through = row.syncId;
      const packet = toPacket(models, row, groups);
      if (packet) this.#packets.push(packet);
      // One mutation writes several rows under the same seq: ack it once.
      if (
        row.clientId === clientId &&
        row.clientSeq !== null &&
        row.clientSeq !== this.#lastAckSeq
      ) {
        this.#acks.push({ clientId, seq: row.clientSeq });
        this.#lastAckSeq = row.clientSeq;
      }
    }
  }

  /**
   * Sends what can be sent. Mid-range (`boundary` false) only full messages go out, keeping one
   * packet in hand to check the `D` rule against. At a transaction boundary everything goes,
   * with the acks on the last message (or alone, when nothing visible changed).
   */
  flush(boundary: boolean): void {
    const max = MAX_PACKETS_PER_MESSAGE;
    const packets = this.#packets;
    let sent = false;
    while (packets.length > max || (boundary && packets.length > 0)) {
      let size = Math.min(max, packets.length);
      if (size < packets.length && splitsPair(packets[size - 1], packets[size])) size -= 1;
      const chunk = packets.splice(0, size);
      const last = packets.length === 0 && boundary;
      this.#send(chunk, last ? this.#takeAcks() : []);
      sent = true;
    }
    if (boundary && !sent && this.#acks.length > 0) this.#send([], this.#takeAcks());
  }

  #send(packets: DeltaPacket[], ack: Ack[]): void {
    this.#options.send({ t: 'deltas', prev: this.#prev, packets, ack });
    const last = packets.at(-1);
    if (last) this.#prev = last.id;
  }

  #takeAcks(): Ack[] {
    const acks = this.#acks;
    this.#acks = [];
    return acks;
  }
}

/** A `D` followed by a packet for the same row: the two halves of a groups change (Q5). */
function splitsPair(a: DeltaPacket | undefined, b: DeltaPacket | undefined): boolean {
  if (a?.a !== 'D' || b === undefined || b.a === 'G') return false;
  return b.m === a.m && rowIdOf(b) === a.mid;
}

function rowIdOf(packet: DeltaPacket): string | undefined {
  switch (packet.a) {
    case 'I':
    case 'U':
      return packet.d.id;
    case 'A':
    case 'V':
    case 'D':
      return packet.mid;
    case 'G':
      return undefined;
  }
}
