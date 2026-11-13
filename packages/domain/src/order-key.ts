/**
 * Issue order keys (SPEC-011 §4.5, §6.2): fractional keys (`fractional-key.ts`, PLAN-010) with a
 * jitter suffix. `sortOrder` is global, so two teams that each put a new issue first read
 * different "lowest" keys but may compute the same key from them; the jitter makes the keys
 * differ. Reads order by `(sortOrder, id)`, so an equal pair would still have a stable order.
 *
 * The server takes random jitter (`jitterFrom` of a `crypto` random integer); the client's `optimistic` takes
 * `jitterFromId(issueId)`, so every rebuild of the overlay computes the same key (SPEC-003 §8).
 * The server's key is the real one; the client's is a prediction, like the issue number.
 *
 * Every key this module returns is a valid fractional key (`isFractionalKey`): the jitter only
 * lengthens its fraction, and never ends in `0`.
 */
import { fractionalKeyBetween } from './fractional-key.js';

/** Base-62 digits in ascending byte order, the alphabet of fractional keys. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Characters of jitter per key: 62³ × 61 ≈ 14.5 million values. */
export const JITTER_LENGTH = 4;

/** Distinct jitter values: the last digit is never `0`. */
const JITTER_VALUES = DIGITS.length ** (JITTER_LENGTH - 1) * (DIGITS.length - 1);

/**
 * The jitter for `seed`, a non-negative integer (taken modulo the number of jitter values): four
 * base-62 digits, the last never `0`, so a key ending in it keeps a unique spelling.
 */
export function jitterFrom(seed: number): string {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error(`Jitter seed must be a non-negative integer, got ${seed}`);
  }
  let rest = seed % JITTER_VALUES;
  // The last digit is 1–61; the others 0–61.
  let out = DIGITS.charAt(1 + (rest % (DIGITS.length - 1)));
  rest = Math.floor(rest / (DIGITS.length - 1));
  for (let i = 1; i < JITTER_LENGTH; i++) {
    out = DIGITS.charAt(rest % DIGITS.length) + out;
    rest = Math.floor(rest / DIGITS.length);
  }
  return out;
}

/** Whether `jitter` is one `jitterFrom` can return. */
export function isJitter(jitter: string): boolean {
  return /^[0-9A-Za-z]{4}$/.test(jitter) && !jitter.endsWith('0');
}

/**
 * The optimistic jitter of an issue (SPEC-011 §6.2): a hash of its id, so it is the same on every
 * replay and never comes from `Math.random`. Case-insensitive, like ids.
 */
export function jitterFromId(id: string): string {
  // FNV-1a, 32 bits: deterministic and spreads ids that differ only in their last characters.
  let hash = 0x811c9dc5;
  for (const char of id.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return jitterFrom(hash);
}

function checkJitter(jitter: string): void {
  if (!isJitter(jitter)) {
    throw new Error(
      `Order key jitter "${jitter}" must be 4 characters of 0-9, A-Z, a-z, not ending in 0`,
    );
  }
}

/**
 * A key strictly between `a` and `b` (either may be null, like `fractionalKeyBetween`), ending in
 * `jitter`. Appending to a key `k` with `a < k < b` stays below `b` unless `k` is a prefix of `b`,
 * so such a `k` is replaced by one that isn't: towards `b` when there is a lower bound, and
 * downwards otherwise, which keeps keys short when issues keep going first.
 */
function jittered(a: string | null, b: string | null, jitter: string): string {
  checkJitter(jitter);
  let key = fractionalKeyBetween(a, b);
  // Each step moves to a strictly shorter or non-prefix key, so it ends within `b.length` steps.
  while (b !== null && b.startsWith(key)) {
    key = a === null ? fractionalKeyBetween(null, key) : fractionalKeyBetween(key, b);
  }
  return key + jitter;
}

/**
 * A key before `first` (the lowest key in the list), or the first key of an empty list when
 * `first` is null. Used to put a new issue first (SPEC-011 §4.5, Q7).
 */
export function keyBefore(first: string | null, jitter: string): string {
  return jittered(null, first, jitter);
}

/**
 * A key strictly between `a` and `b` in byte order (`a` null: before `b`; `b` null: after `a`).
 * Throws when a key is malformed or `a >= b`, like `fractionalKeyBetween`.
 */
export function keyBetween(a: string | null, b: string | null, jitter: string): string {
  return jittered(a, b, jitter);
}
