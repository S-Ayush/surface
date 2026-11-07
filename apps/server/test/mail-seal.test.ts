// PLAN-001 S4: email job payloads are sealed, so a queued login, reset or invite link is never
// readable in `pgboss.job` or a backup of it (ADR-0007: tokens are stored only as hashes).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emailSealKey, seal, unseal } from '../src/mail/seal.js';

const key = emailSealKey('a'.repeat(64));

describe('seal', () => {
  it('opens what it sealed, and hides it', () => {
    const plain = '{"link":"https://surface.example.com/auth/magic?token=secret"}';
    const sealed = seal(key, plain);
    expect(sealed).not.toContain('secret');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(unseal(key, sealed)).toBe(plain);
  });

  it('never seals the same text the same way twice', () => {
    expect(seal(key, 'same')).not.toBe(seal(key, 'same'));
  });

  it('derives the same key from the same secret, and another from another', () => {
    expect(emailSealKey('a'.repeat(64)).equals(key)).toBe(true);
    const other = emailSealKey('b'.repeat(64));
    expect(other.equals(key)).toBe(false);
    expect(unseal(other, seal(key, 'text'))).toBeUndefined();
  });

  it('refuses malformed payloads', () => {
    for (const bad of [
      '',
      'v1',
      'v1..',
      'v2.AAAA.AAAA',
      'v1.AAAA.AAAA',
      'v1.a.b.c',
      'not sealed',
    ]) {
      expect(unseal(key, bad), bad).toBeUndefined();
    }
  });

  it('refuses any altered payload (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), fc.integer({ min: 1, max: 255 }), (plain, at, flip) => {
        const sealed = seal(key, plain);
        expect(unseal(key, sealed)).toBe(plain);
        const [version, iv, body] = sealed.split('.');
        if (version === undefined || iv === undefined || body === undefined) return;
        // Flip bits in one byte of the IV, the ciphertext or the tag.
        const ivBytes = Buffer.from(iv, 'base64url');
        const bodyBytes = Buffer.from(body, 'base64url');
        const all = Buffer.concat([ivBytes, bodyBytes]);
        const index = at % all.length;
        all[index] = (all[index] ?? 0) ^ flip;
        const altered = `v1.${all.subarray(0, ivBytes.length).toString('base64url')}.${all
          .subarray(ivBytes.length)
          .toString('base64url')}`;
        expect(unseal(key, altered)).toBeUndefined();
      }),
      // A fixed seed, so a failure reproduces (.claude/rules/testing.md).
      { seed: 20261107 },
    );
  });
});
