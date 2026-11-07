/**
 * Server-side sessions (ADR-0007, SPEC-001 AC-7): the cookie `surface_session` carries a random
 * 256-bit token; the database keeps only its SHA-256. PLAN-001 S2 creates the first session at
 * setup; S3 signs in, reads the cookie back (`auth/sessions.ts`) and adds CSRF (`auth/csrf.ts`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '../db/uuidv7.js';

export const SESSION_COOKIE = 'surface_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The part of a pg client or pool this module needs. */
export interface SessionWriter {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface NewSession {
  readonly userId: string;
  readonly userAgent: string | undefined;
  readonly ip: string | undefined;
  readonly now: Date;
}

export interface CreatedSession {
  readonly id: string;
  /** The cookie value. Shown once, to the client; never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** SHA-256 of a session token, as stored in `sessions.token_hash`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Inserts a session (in the caller's transaction, if any) and returns its token. */
export async function createSession(
  db: SessionWriter,
  session: NewSession,
): Promise<CreatedSession> {
  const id = uuidv7();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(session.now.getTime() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_used_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
    [
      id,
      session.userId,
      hashSessionToken(token),
      // Shown in the sessions list (SPEC-001 §3.5); bounded so a client can't store a novel.
      session.userAgent?.slice(0, 512) ?? null,
      session.ip ?? null,
      session.now,
      expiresAt,
    ],
  );
  return { id, token, expiresAt };
}

/** The `Set-Cookie` value for a session: HttpOnly, SameSite=Lax, Secure on https (AC-7). */
export function sessionCookie(token: string, { secure }: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** A `Set-Cookie` value that deletes the cookie `name` (sign-out, an expired session). */
export function clearedCookie(name: string, { secure }: { secure: boolean }): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The value of cookie `name` in a `Cookie` header, if present and non-empty. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}
