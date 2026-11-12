// A client-generated UUIDv7 (RFC 9562 §5.7) for a new row's id (SPEC-003 §8, E7): create ops such
// as `team.create` take one, so the optimistic insert and the server's row share the id. The
// store's own helper makes v4 ids only. `crypto.getRandomValues` exists in browsers (over plain
// HTTP too, unlike `randomUUID`) and in Node. The server keeps its own monotonic generator
// (apps/server/src/db/uuidv7.ts), which orders ids made in the same millisecond.
import { sha1, utf8Bytes } from './sha1.js';

// The domain package compiles without DOM or Node types; both runtimes have this global.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 48 bits of Unix milliseconds, then version 7, 74 random bits and the RFC 9562 variant. */
export function uuidv7(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const bytes = new Uint8Array(16);
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  return formatUuid(bytes);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError(`Not a UUID: ${uuid}`);
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/**
 * A name-based UUIDv5 (RFC 9562 §5.5): the same name and namespace always give the same id, in
 * the browser and in Node. Used for ids derived from other ids, such as `reactionId`.
 */
export function uuidv5(name: string, namespace: string): string {
  const ns = uuidBytes(namespace);
  const nameBytes = utf8Bytes(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const bytes = sha1(input).subarray(0, 16);
  bytes[6] = 0x50 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  return formatUuid(bytes);
}
