/**
 * Sealed email job payloads (PLAN-001 S4). An email job carries a login, reset or invite link,
 * and the link's token is a credential: only its hash is stored (ADR-0007), so the raw token
 * must not sit readable in `pgboss.job` or in a backup of it. The payload is encrypted with
 * AES-256-GCM under a key derived from `SESSION_SECRET`; tampering makes it unreadable.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 256-bit key from {@link emailSealKey}. */
export type SealKey = Buffer;

/** The key for email jobs. Changing `SESSION_SECRET` makes queued emails unreadable. */
export function emailSealKey(sessionSecret: string): SealKey {
  return Buffer.from(hkdfSync('sha256', sessionSecret, 'surface', 'email-job/v1', 32));
}

export function seal(key: SealKey, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${iv.toString('base64url')}.${body.toString('base64url')}`;
}

/** The plaintext, or `undefined` when the payload was not sealed with this key or was altered. */
export function unseal(key: SealKey, sealed: string): string | undefined {
  const [version, ivText, bodyText, ...rest] = sealed.split('.');
  if (version !== VERSION || ivText === undefined || bodyText === undefined || rest.length > 0) {
    return undefined;
  }
  const iv = Buffer.from(ivText, 'base64url');
  const body = Buffer.from(bodyText, 'base64url');
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return undefined;
  }
}
