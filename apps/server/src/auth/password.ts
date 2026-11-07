/**
 * Password hashing (ADR-0007, SPEC-001 AC-9): argon2id with m = 19 MiB, t = 2, p = 1, the OWASP
 * baseline. The parameters travel inside each hash, so raising them later still verifies old ones.
 */
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`. The package declares `Algorithm` as a const enum, which can't be read
 * under `verbatimModuleSyntax`; the test checks the hashes really are argon2id.
 */
const ARGON2ID: Algorithm = 2;

export const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19 * 1024, // KiB
  timeCost: 2,
  parallelism: 1,
};

/** A PHC string (`$argon2id$v=19$m=19456,t=2,p=1$…`) with a fresh random salt. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** False for a wrong password or a hash that isn't one of ours, never an error. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
