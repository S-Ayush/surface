/**
 * What sign-in reads and writes in Postgres (PLAN-001 S3), behind an interface so the routes are
 * unit-tested against a fake. Sessions, credentials and `auth_attempts` are server-only tables
 * (never synced), so plain SQL is right here; the repo layer is for synced tables only.
 */
import type { Membership, Role } from '@surface/domain';
import type pg from 'pg';
import { z } from 'zod';
import { createSession, SESSION_TTL_MS, type CreatedSession, type NewSession } from './session.js';

export interface Credentials {
  readonly userId: string;
  readonly passwordHash: string;
}

/** A live session and what the actor is built from, read fresh on every request. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly memberships: readonly Membership[];
  readonly lastUsedAt: Date;
}

export interface AuthStore {
  /** The password hash of an active user with this (lowercase) email. */
  credentials(email: string): Promise<Credentials | undefined>;
  createSession(session: NewSession): Promise<CreatedSession>;
  /** The session with this token hash, unless it expired or its user was deactivated. */
  session(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  /** Sliding expiry: the session lasts 30 days from now. */
  touch(sessionId: string, now: Date): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

const SessionRow = z.object({
  id: z.string(),
  user_id: z.string(),
  workspace_id: z.string(),
  role: z.enum(['admin', 'member']),
  last_used_at: z.date(),
  memberships: z.array(z.object({ teamId: z.string(), private: z.boolean() })),
});

// One round trip per request: the session, its user, the workspace and every team membership.
// Memberships are read each time, so joining or leaving a team applies to the next request.
const SELECT_SESSION = `
  SELECT s.id, s.user_id, s.last_used_at, u.role,
         (SELECT w.id FROM workspace w) AS workspace_id,
         COALESCE((SELECT json_agg(json_build_object('teamId', m.team_id, 'private', t.private))
                     FROM team_memberships m JOIN teams t ON t.id = m.team_id
                    WHERE m.user_id = s.user_id), '[]'::json) AS memberships
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active`;

export function pgAuthStore(pool: Pick<pg.Pool, 'query'>): AuthStore {
  return {
    async credentials(email) {
      const { rows } = await pool.query<{ user_id: string; password_hash: string }>(
        `SELECT c.user_id, c.password_hash
           FROM users u JOIN user_credentials c ON c.user_id = u.id
          WHERE u.email = $1 AND u.active`,
        [email],
      );
      const row = rows[0];
      return row && { userId: row.user_id, passwordHash: row.password_hash };
    },

    createSession: (session) => createSession(pool, session),

    async session(tokenHash, now) {
      const { rows } = await pool.query(SELECT_SESSION, [tokenHash, now]);
      if (rows[0] === undefined) return undefined;
      const row = SessionRow.parse(rows[0]);
      return {
        id: row.id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        role: row.role,
        memberships: row.memberships,
        lastUsedAt: row.last_used_at,
      };
    },

    async touch(sessionId, now) {
      await pool.query('UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1', [
        sessionId,
        now,
        new Date(now.getTime() + SESSION_TTL_MS),
      ]);
    },

    async deleteSession(sessionId) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    },
  };
}
