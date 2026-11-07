/**
 * The setup token (SPEC-001 §3.1): whoever holds it can create the first Admin, so it is long and
 * random, only its hash is stored, and it is compared in constant time. It is shown in the setup
 * link the server logs, which is the one secret the spec puts in the logs: the operator has no
 * other way to get it, and it stops working once setup is done.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford's base32 without I, L, O and U: easy to read off a terminal and to type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 160 random bits as eight groups of four: `ABCD-EFGH-…`. */
export function generateSetupToken(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    // At most 12 bits are pending (4 left over + 8 new), so 16 keep it inside a 32-bit int.
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  return out.match(/.{4}/g)?.join('-') ?? out;
}

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

/** Whether `token` hashes to `storedHash`, in time that doesn't depend on where they differ. */
export function setupTokenMatches(storedHash: string | null, token: string): boolean {
  if (storedHash === null) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashSetupToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The link the operator opens: `<SURFACE_URL>/setup?token=…`. */
export function setupUrl(publicUrl: string, token: string): string {
  const url = new URL('/setup', publicUrl);
  url.searchParams.set('token', token);
  return url.toString();
}
