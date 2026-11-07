/**
 * Account rules shared by the client and the server (SPEC-001). Setup (PLAN-001 S2), invites,
 * password reset and change password all use them, so the forms can say what is wrong before
 * the server does.
 */
import { z } from 'zod';

/** SPEC-001 AC-9. */
export const PASSWORD_MIN_LENGTH = 10;
/** Long enough for any passphrase; it bounds the work argon2 does on input we don't control. */
export const PASSWORD_MAX_LENGTH = 256;

/** Why `password` can't be used, or undefined if it can. */
export function passwordProblem(password: string): string | undefined {
  // Counted in code points, so an emoji is one character, as the user sees it.
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`;
  }
  return undefined;
}

/** RFC 5321's limit on a forward path. */
export const EMAIL_MAX_LENGTH = 254;

const emailSchema = z.email();

/** Why `email` can't be used, or undefined if it can. Surrounding spaces are ignored. */
export function emailProblem(email: string): string | undefined {
  const trimmed = email.trim();
  if (trimmed.length === 0) return 'Email is required';
  if (trimmed.length > EMAIL_MAX_LENGTH) {
    return `Email must be at most ${EMAIL_MAX_LENGTH} characters long`;
  }
  return emailSchema.safeParse(trimmed).success
    ? undefined
    : 'Email must look like name@example.com';
}

/**
 * An email as stored and looked up: without surrounding spaces, in lowercase (SPEC-001 E2). Setup,
 * sign-in and invites all use this, so an address typed differently still finds its account.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
