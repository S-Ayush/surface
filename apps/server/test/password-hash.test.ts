// SPEC-001 AC-9: passwords are stored with argon2id (m = 19 MiB, t = 2, p = 1). The minimum length
// is `passwordProblem` in @surface/domain (auth.test.ts) and is enforced by every form that sets one.
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing (AC-9)', () => {
  it('stores argon2id with m = 19 MiB, t = 2, p = 1, and never the password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[^$]+\$[^$]+$/);
    expect(stored).not.toContain('correct horse battery');
  });

  it('salts every hash, so the same password hashes differently', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!'),
      hashPassword('same password!'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and refuses a wrong one or a malformed hash', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword(stored, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword('not a hash', 'correct horse battery')).toBe(false);
  });
});
