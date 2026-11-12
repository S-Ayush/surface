/**
 * Seeded randomness for the simulation. A case must replay exactly from its
 * seed (`pnpm sim --seed <n>`), so nothing in it may draw from an unseeded
 * source: the network, the clients' backoff jitter, and the engine's own
 * draws all come from here. The engine uses `crypto.getRandomValues` (tab
 * tokens and fresh client ids, `sync-client/src/uuid.ts`) and `Math.random`
 * (replica generations); `crypto.randomUUID` is stubbed too, in case it is
 * ever used. `test/replay.test.ts` checks that runs replay exactly.
 *
 * The real server runs in the same process, and how often it draws depends on
 * real timing: each new Postgres connection makes a SCRAM nonce, and its pools
 * open more connections under load. Its draws get real randomness
 * (`SERVER_CODE`), so they never shift the case's.
 */
import { randomFillSync } from 'node:crypto';
import { vi } from 'vitest';

export type Random = () => number;

/** mulberry32: small, fast and good enough to drive faults. Values in [0, 1). */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max]. */
export function between(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** A version 4 UUID built from `random`. */
export function uuidFrom(random: Random): `${string}-${string}-${string}-${string}-${string}` {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = (8 + Math.floor(random() * 4)).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The in-process real server, by file path: its own code and the libraries it
 * draws through (the Postgres driver's SCRAM nonces, fastify's plugin loader).
 * What they draw is theirs, not the case's (`SeedOptions.realFor`). The
 * integration suite fails on any server draw this misses.
 */
export const SERVER_CODE =
  /[/\\]apps[/\\]server[/\\]|[/\\]node_modules[/\\](?:pg|pg-[a-z]+|avvio|fastify|@fastify[/\\][a-z-]+)[/\\]/;

export interface SeedOptions {
  /** A draw whose call stack has a frame matching this gets real randomness, not `random`'s. */
  readonly realFor?: RegExp;
}

/** Frames enough to reach the caller through the spies and a driver's helpers. */
const STACK_FRAMES = 30;

/**
 * Replace `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`
 * with draws from `random` until the returned function restores them.
 */
export function seedGlobals(random: Random, options: SeedOptions = {}): () => void {
  const { realFor } = options;
  const realRandom = Math.random;
  const realUuid = crypto.randomUUID.bind(crypto);
  const unseeded = (): boolean => {
    if (realFor === undefined) return false;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_FRAMES;
    try {
      return realFor.test(new Error().stack ?? '');
    } finally {
      Error.stackTraceLimit = limit;
    }
  };
  const math = vi
    .spyOn(Math, 'random')
    .mockImplementation(() => (unseeded() ? realRandom() : random()));
  const values = vi
    .spyOn(crypto, 'getRandomValues')
    .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      if (unseeded()) {
        randomFillSync(bytes);
        return array;
      }
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
      return array;
    });
  const uuid = vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(() => (unseeded() ? realUuid() : uuidFrom(random)));
  return () => {
    math.mockRestore();
    values.mockRestore();
    uuid.mockRestore();
  };
}
