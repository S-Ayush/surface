/**
 * `GET /sync/ws` (sync-protocol.md §4.3): connect parameters, server → client
 * messages, client → server messages and close codes.
 *
 * Not in v0 (SPEC-002 §2): `presence` in both directions arrives in M4. A `G`
 * packet is part of the stream ordering, so it is decoded here; until M7 the
 * client handles it with a full re-bootstrap.
 */
import { z } from 'zod';
import { decodeWith, parseJson } from './errors.js';
import {
  clientIdSchema,
  modelNameSchema,
  rowSchema,
  schemaHashSchema,
  seqSchema,
  syncGroupSchema,
  syncIdSchema,
  userIdSchema,
  uuidSchema,
} from './scalars.js';
import { requireUserId } from './user-id.js';

export const SOCKET_PATH = '/sync/ws';

/** sync-protocol.md §9. */
export const MAX_PACKETS_PER_MESSAGE = 500;
export const PING_INTERVAL_MS = 25_000;
export const PING_TIMEOUT_MS = 10_000;

/** WebSocket close codes with a protocol meaning. */
export const CloseCode = {
  /** The server is shutting down; reconnect with backoff (PLAN-002 S4). */
  ServiceRestart: 1012,
  /** The session was revoked; stop reconnecting and go to login (SPEC-002 E10). */
  SessionRevoked: 4001,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

// ---------------------------------------------------------------------------
// Connect parameters

/**
 * Query string of the WebSocket URL. `schemaHash` lets the hub answer
 * `resync(schema)` before catch-up (SPEC-002 §4.3). `userId` is the user the
 * client's replica belongs to; the session must be the same user (SPEC-002
 * E14). Missing, it is a `MissingUserIdError`: the hub accepts the upgrade and
 * answers `resync(schema)`, which an old client turns into the reload banner (a
 * refused upgrade is only a `1006` to a browser).
 */
export const socketConnectParamsSchema = z.object({
  since: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, { message: 'since must be a non-negative integer' })
    .transform(Number)
    .pipe(syncIdSchema),
  clientId: clientIdSchema,
  userId: userIdSchema,
  schemaHash: schemaHashSchema,
});

export type SocketConnectParams = z.output<typeof socketConnectParamsSchema>;

/** Build the query string (without `?`) for `GET /sync/ws`. */
export function encodeSocketConnectParams(params: SocketConnectParams): string {
  return new URLSearchParams({
    since: String(params.since),
    clientId: params.clientId,
    userId: params.userId,
    schemaHash: params.schemaHash,
  }).toString();
}

/**
 * Validate the parsed query of `GET /sync/ws`. Throws `MissingUserIdError`
 * (answer `resync(schema)`) when it has no `userId`, else `ProtocolError` (`400`).
 */
export function decodeSocketConnectParams(query: unknown): SocketConnectParams {
  requireUserId(query, 'connect parameters');
  return decodeWith(socketConnectParamsSchema, query, 'connect parameters');
}

// ---------------------------------------------------------------------------
// Delta packets (one `sync_log` row each)

/** `I` insert and `U` update both carry the full row, applied as an idempotent upsert. */
export const upsertPacketSchema = z.object({
  id: syncIdSchema,
  a: z.enum(['I', 'U']),
  m: modelNameSchema,
  d: rowSchema,
});

/**
 * `A` archive and `V` unarchive or restore carry the full row too (v0.7, SPEC-011 §5.5): the
 * client applies them as an upsert plus the flag, so a `V` for a row it doesn't hold inserts it.
 * Strict, like the delete packet, so a packet carrying both `d` and `mid` is refused rather than
 * decoded with one silently dropped.
 */
export const archivePacketSchema = z.strictObject({
  id: syncIdSchema,
  a: z.enum(['A', 'V']),
  m: modelNameSchema,
  d: rowSchema,
});

/** `D` hard delete (a purge, or the row left the connection's groups): the id only (SPEC-002 Q4). */
export const deletePacketSchema = z.strictObject({
  id: syncIdSchema,
  a: z.literal('D'),
  m: modelNameSchema,
  mid: uuidSchema,
});

/** `G`: this user's sync groups changed (permissions.md §2). M7. */
export const groupChangePacketSchema = z.object({
  id: syncIdSchema,
  a: z.literal('G'),
  added: z.array(syncGroupSchema),
  removed: z.array(syncGroupSchema),
});

export const deltaPacketSchema = z.discriminatedUnion('a', [
  upsertPacketSchema,
  archivePacketSchema,
  deletePacketSchema,
  groupChangePacketSchema,
]);

export type UpsertPacket = z.infer<typeof upsertPacketSchema>;
export type ArchivePacket = z.infer<typeof archivePacketSchema>;
export type DeletePacket = z.infer<typeof deletePacketSchema>;
export type GroupChangePacket = z.infer<typeof groupChangePacketSchema>;
export type DeltaPacket = z.infer<typeof deltaPacketSchema>;
export type PacketAction = DeltaPacket['a'];

/** A mutation of this connection's client that the packets in this message confirm. */
export const ackSchema = z.object({ clientId: clientIdSchema, seq: seqSchema });
export type Ack = z.infer<typeof ackSchema>;

// ---------------------------------------------------------------------------
// Server → client

/**
 * A batch of deltas for this connection's filtered stream.
 *
 * `prev` is the id of the last packet the server sent on this connection before
 * this message (or the connect `since`). The client applies the batch only if
 * `prev` equals its `lastSyncId`; otherwise it has missed packets and reconnects
 * (SPEC-002 E1). Packet ids are strictly increasing and greater than `prev`.
 *
 * `packets` may be empty only when `ack` is not: a client's own mutation can
 * write rows it cannot see, and its pending entry must still be confirmed.
 */
export const deltasMessageSchema = z
  .object({
    t: z.literal('deltas'),
    prev: syncIdSchema,
    packets: z.array(deltaPacketSchema).max(MAX_PACKETS_PER_MESSAGE),
    ack: z.array(ackSchema),
  })
  .superRefine((message, ctx) => {
    if (message.packets.length === 0 && message.ack.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'deltas must carry packets or acks' });
    }
    let last = message.prev;
    message.packets.forEach((packet, index) => {
      if (packet.id <= last) {
        ctx.addIssue({
          code: 'custom',
          path: ['packets', index, 'id'],
          message: 'packet ids must be strictly increasing and greater than prev',
        });
      }
      last = packet.id;
    });
  });

export const resyncReasonSchema = z.enum(['schema', 'too_old', 'groups']);
export type ResyncReason = z.infer<typeof resyncReasonSchema>;

/** The client must re-bootstrap; pending mutations survive (SPEC-002 E7, E8). */
export const resyncMessageSchema = z.object({ t: z.literal('resync'), reason: resyncReasonSchema });

export const pingMessageSchema = z.object({ t: z.literal('ping') });

export const serverMessageSchema = z.discriminatedUnion('t', [
  deltasMessageSchema,
  resyncMessageSchema,
  pingMessageSchema,
]);

export type DeltasMessage = z.infer<typeof deltasMessageSchema>;
export type ResyncMessage = z.infer<typeof resyncMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Client → server

export const pongMessageSchema = z.object({ t: z.literal('pong') });

export const clientMessageSchema = z.discriminatedUnion('t', [pongMessageSchema]);

export type PongMessage = z.infer<typeof pongMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Text frames

/** Serialise a message for a WebSocket text frame. Inputs are typed, so they are not re-validated. */
export function encodeSocketMessage(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Decode a server → client text frame. Throws `ProtocolError`. */
export function decodeServerMessage(text: string): ServerMessage {
  return decodeWith(serverMessageSchema, parseJson(text, 'server message'), 'server message');
}

/** Decode a client → server text frame. Throws `ProtocolError`. */
export function decodeClientMessage(text: string): ClientMessage {
  return decodeWith(clientMessageSchema, parseJson(text, 'client message'), 'client message');
}
