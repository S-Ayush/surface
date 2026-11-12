/**
 * Fractional-index keys for manual order (domain-model §1, SPEC-010 §4.1): a new key between any
 * two keys, so a move or an insert writes one row and never renumbers the others. Shared by the
 * client's `optimistic` and the server, so both compute the same key from the same neighbours.
 *
 * Written in-house (SPEC-010 §4.1: no new dependency). Keys compare by **byte order**: in SQL the
 * column is `COLLATE "C"`, and in JS plain `<` on these ASCII keys is the same order.
 *
 * A key is an integer part followed by an optional fraction, both in base-62 digits
 * (`0-9A-Za-z`, which is ascending in ASCII). The integer part's first character gives its
 * length: `a`–`z` are 2–27 characters (non-negative integers, growing upwards), `A`–`Z` are
 * 27–2 characters (negative integers). So `a0`, `a1`, … `az`, `b00`, … count up, and the seed's
 * `a0`, `a1` keys (`handlers/teams/seed.ts`) are valid keys of this scheme. Appending to the end
 * increments the integer, so keys stay short; a fraction is used only between two neighbours.
 * A fraction never ends in `0`, so every key has a unique spelling.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = '0';
const LAST = 'z';
/** The smallest integer part. Nothing sorts before it, so it can't be a key on its own. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
const KEY_PATTERN = /^[0-9A-Za-z]+$/;

function digitValue(char: string | undefined): number {
  return char === undefined ? -1 : DIGITS.indexOf(char);
}

function digitAt(value: number): string {
  const char = DIGITS[value];
  if (char === undefined) throw new Error(`No base-62 digit for ${value}`);
  return char;
}

/** The length of the integer part that `head` starts, or undefined if it can't start one. */
function integerLength(head: string | undefined): number | undefined {
  if (head === undefined) return undefined;
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return undefined;
}

/** Why `key` is not a fractional key, or undefined if it is. */
export function fractionalKeyProblem(key: string): string | undefined {
  if (!KEY_PATTERN.test(key)) return `Order key "${key}" must use only 0-9, A-Z and a-z`;
  const length = integerLength(key[0]);
  if (length === undefined || key.length < length) {
    return `Order key "${key}" has a malformed integer part`;
  }
  if (key === SMALLEST_INTEGER) return `Order key "${key}" is reserved`;
  if (key.length > length && key.endsWith(ZERO)) {
    return `Order key "${key}" must not end in 0 after its integer part`;
  }
  return undefined;
}

export function isFractionalKey(key: string): boolean {
  return fractionalKeyProblem(key) === undefined;
}

function checkKey(key: string): void {
  const problem = fractionalKeyProblem(key);
  if (problem !== undefined) throw new Error(problem);
}

function split(key: string): { readonly integer: string; readonly fraction: string } {
  const length = integerLength(key[0]) ?? key.length;
  return { integer: key.slice(0, length), fraction: key.slice(length) };
}

/**
 * A fraction strictly between `a` and `b` (`b` null = no upper bound). Both are digit strings
 * with no trailing zero, and `a < b`. `''` is the smallest fraction.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Keep the common prefix (`a` padded with zeros) and find a midpoint after it.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  // The first digits differ (or `a` has none).
  const low = a === '' ? 0 : digitValue(a[0]);
  const high = b === null ? DIGITS.length : digitValue(b[0]);
  if (high - low > 1) return digitAt(Math.round((low + high) / 2));
  // Consecutive first digits: `b`'s first digit alone is between them when `b` goes on.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  // Otherwise keep `a`'s first digit and go above the rest of `a`.
  return digitAt(low) + midpoint(a.slice(1), null);
}

/** The next integer part, or null after the largest one (`z` followed by 26 `z`s). */
function incrementInteger(integer: string): string | null {
  const head = integer.slice(0, 1);
  const digits = integer.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digitValue(digits[i]) + 1;
    if (next < DIGITS.length) {
      digits[i] = digitAt(next);
      return head + digits.join('');
    }
    digits[i] = ZERO;
  }
  // Every digit carried: the next head, one digit longer (a–z) or shorter (A–Z).
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

/** The previous integer part, or null before the smallest one. */
function decrementInteger(integer: string): string | null {
  const head = integer.slice(0, 1);
  const digits = integer.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const previous = digitValue(digits[i]) - 1;
    if (previous >= 0) {
      digits[i] = digitAt(previous);
      return head + digits.join('');
    }
    digits[i] = LAST;
  }
  if (head === 'a') return `Z${LAST}`;
  if (head === 'A') return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < 'Z') digits.push(LAST);
  else digits.pop();
  return previousHead + digits.join('');
}

/**
 * A key strictly between `a` and `b` in byte order. `a` null means "before `b`" (the start of the
 * list), `b` null means "after `a`" (the end), both null is the first key of an empty list (`a0`).
 * Throws when a key is malformed or `a >= b`: the caller passes neighbours it read in order.
 * Deterministic: equal neighbours give equal keys, so a client's prediction matches the server
 * when both read the same neighbours (SPEC-010 §4.1).
 */
export function fractionalKeyBetween(a: string | null, b: string | null): string {
  if (a !== null) checkKey(a);
  if (b !== null) checkKey(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`Order key "${a}" must sort before "${b}"`);
  }
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const { integer, fraction } = split(b);
    if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction);
    if (fraction !== '') return integer;
    const previous = decrementInteger(integer);
    if (previous === null) throw new Error(`No order key fits before "${b}"`);
    // The smallest integer is reserved (nothing could go before it), so it needs a fraction.
    return previous === SMALLEST_INTEGER ? previous + midpoint('', null) : previous;
  }
  const lower = split(a);
  if (b === null) {
    const next = incrementInteger(lower.integer);
    return next ?? lower.integer + midpoint(lower.fraction, null);
  }
  const upper = split(b);
  if (lower.integer === upper.integer) {
    return lower.integer + midpoint(lower.fraction, upper.fraction);
  }
  const next = incrementInteger(lower.integer);
  if (next !== null && next < b) return next;
  return lower.integer + midpoint(lower.fraction, null);
}
