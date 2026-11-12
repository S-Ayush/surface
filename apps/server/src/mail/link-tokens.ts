/**
 * Single-use sign-in and password reset links (SPEC-001 §3.2, §3.3; state-machines.md "Tokens").
 * The link carries a random 256-bit token; the database keeps only its SHA-256, like sessions.
 *
 * - A magic link lasts 15 minutes, a reset link 1 hour. `LINK_LIFETIME_TEXT` says the same in
 *   the emails (a test keeps them equal).
 * - Issuing a link turns off the user's earlier unused ones of that kind: only the newest works
 *   (E9). The user's row is locked first, so two requests at once can't both stay valid.
 * - Using a link is one `UPDATE … WHERE used_at IS NULL`: two uses at once, one wins.
 *
 * Server-only tables, so plain SQL on the caller's transaction; the repo layer is for synced
 * tables only (CLAUDE.md rule 2).
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { uuidv7 } from '../db/uuidv7.js';
import { inviteUrl, passwordResetUrl } from './links.js';

export type LinkKind = 'magicLink' | 'passwordReset';

export const LINK_TTL_MS: Readonly<Record<LinkKind, number>> = {
  magicLink: 15 * 60 * 1000,
  passwordReset: 60 * 60 * 1000,
};

/**
 * A link the user asks for again within this long sends nothing new: the generic answer stays
 * the same, but someone can't fill a mailbox by asking over and over (PLAN-001 S4).
 */
export const LINK_REQUEST_COOLDOWN_MS = 60 * 1000;

// Constant table names, never input.
const TABLE: Readonly<Record<LinkKind, string>> = {
  magicLink: 'magic_link_tokens',
  passwordReset: 'password_reset_tokens',
};

/** The part of a pg connection these functions use: the caller's transaction. */
export type LinkDb = Pick<pg.PoolClient, 'query'>;

export interface IssuedLink {
  /** Goes into the URL. Shown once; never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** SHA-256 of a link token, as stored in `token_hash`. */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh random 256-bit link token and the hash to store for it. */
export function newLinkToken(): { readonly token: string; readonly tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashLinkToken(token) };
}

/** Ours are 43 characters; anything far longer isn't worth hashing. */
export const LINK_TOKEN_MAX_LENGTH = 128;

export interface IssueOptions {
  readonly now: Date;
  /** Issue nothing if an unused link of this kind is younger than this (user requests only). */
  readonly cooldownMs?: number;
}

/**
 * A new link for `userId`, turning off the earlier ones of this kind (E9). `undefined` when an
 * unused link was issued within `cooldownMs`, or the user doesn't exist.
 */
export async function issueLink(
  db: LinkDb,
  kind: LinkKind,
  userId: string,
  { now, cooldownMs }: IssueOptions,
): Promise<IssuedLink | undefined> {
  const table = TABLE[kind];
  // Serialises issuing per user (E9). A row lock only: it changes nothing that syncs.
  const user = await db.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  if (user.rowCount === 0) return undefined;
  if (cooldownMs !== undefined) {
    const recent = await db.query(
      `SELECT 1 FROM ${table}
        WHERE user_id = $1 AND used_at IS NULL AND expires_at > $2 AND created_at > $3
        LIMIT 1`,
      [userId, now, new Date(now.getTime() - cooldownMs)],
    );
    if ((recent.rowCount ?? 0) > 0) return undefined;
  }
  // Earlier links, used or not, are of no further use.
  await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  const { token, tokenHash } = newLinkToken();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS[kind]);
  await db.query(
    `INSERT INTO ${table} (id, user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), userId, tokenHash, now, expiresAt],
  );
  return { token, expiresAt };
}

/**
 * Uses a link: the id of its user, if the link is unused, unexpired and its user active.
 * Anything else (unknown, used, expired, deactivated) is `undefined`, all alike.
 */
export async function useLink(
  db: LinkDb,
  kind: LinkKind,
  token: string,
  now: Date,
): Promise<string | undefined> {
  if (token.length === 0 || token.length > LINK_TOKEN_MAX_LENGTH) return undefined;
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE ${TABLE[kind]} t SET used_at = $2
       FROM users u
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > $2
        AND u.id = t.user_id AND u.active
      RETURNING t.user_id`,
    [hashLinkToken(token), now],
  );
  return rows[0]?.user_id;
}

/** The active user with this (normalised) email. */
export async function activeUserByEmail(
  db: LinkDb,
  email: string,
): Promise<{ readonly id: string; readonly email: string } | undefined> {
  const { rows } = await db.query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE email = $1 AND active',
    [email],
  );
  return rows[0];
}

/** The workspace's name, for the email's wording. */
export async function workspaceName(db: LinkDb): Promise<string> {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM workspace LIMIT 1');
  return rows[0]?.name ?? 'Surface';
}

/** Sets a user's password hash (argon2id, `auth/password.ts`). */
export async function setPasswordHash(
  db: LinkDb,
  userId: string,
  passwordHash: string,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                         updated_at = EXCLUDED.updated_at`,
    [userId, passwordHash, now],
  );
}

/** Links a handler can issue on its operation's transaction (`ctx.links`; PLAN-001 S4, S5). */
export interface HandlerLinks {
  /**
   * A password reset link for `userId`, valid 1 hour, as a URL on `SURFACE_URL`; the user's
   * earlier reset links stop working. `undefined` if the user doesn't exist.
   */
  passwordReset(userId: string): Promise<{ url: string; expiresAt: Date } | undefined>;
  /**
   * A new invite link, `/invite/<token>` on `SURFACE_URL` (PLAN-001 S5). Nothing is stored: the
   * handler saves `tokenHash` with the invite's other fields.
   */
  invite(): { readonly url: string; readonly tokenHash: string };
}

export function handlerLinks(db: LinkDb, publicUrl: string | undefined, now: Date): HandlerLinks {
  // Executors built without one (tests) can't issue links; a handler that needs one fails.
  const origin = (): string => {
    if (publicUrl === undefined) throw new Error('ctx.links needs the executor’s publicUrl');
    return publicUrl;
  };
  return {
    async passwordReset(userId) {
      const base = origin();
      const link = await issueLink(db, 'passwordReset', userId, { now });
      return link && { url: passwordResetUrl(base, link.token), expiresAt: link.expiresAt };
    },
    invite() {
      const base = origin();
      const { token, tokenHash } = newLinkToken();
      return { url: inviteUrl(base, token), tokenHash };
    },
  };
}
