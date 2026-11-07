// A client-generated UUIDv7 (RFC 9562 §5.7) for a new row's id (SPEC-003 §8, E7): create ops such
// as `team.create` take one, so the optimistic insert and the server's row share the id. The
// store's own helper makes v4 ids only. `crypto.getRandomValues` exists in browsers (over plain
// HTTP too, unlike `randomUUID`) and in Node. The server keeps its own monotonic generator
// (apps/server/src/db/uuidv7.ts), which orders ids made in the same millisecond.

// The domain package compiles without DOM or Node types; both runtimes have this global.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

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
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
