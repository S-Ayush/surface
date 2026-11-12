/**
 * What accepting an invite reads and writes (PLAN-001 S5), on the route's transaction. Behind an
 * interface, so the routes are unit-tested against a fake; the SQL was checked by hand against
 * Postgres (integration tests are held, plans README §6).
 *
 * Synced rows (the user, their preferences, memberships) go through the repo, which logs them
 * for sync in the same transaction (CLAUDE.md rule 2). Invites, credentials, sessions and the
 * event outbox are server-only tables.
 */
import type { UserRole } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { createSession, type CreatedSession, type NewSession } from '../../auth/session.js';
import { deleteUserSessions, type SessionSelection } from '../../auth/store.js';
import { eventOutbox } from '../../db/schema/index.js';
import { uuidv7 } from '../../db/uuidv7.js';
import { syncRepo } from '../../sync/repo.js';
import { isUniqueViolation } from '../teams/shared.js';

type Db = pg.PoolClient;

/** What the invite page shows (SPEC-001 §7: the workspace name and who invited). */
export interface InviteDetails {
  readonly workspaceName: string;
  readonly inviterName: string;
  /** Prefilled and locked on the page; null when the invitee enters it. */
  readonly email: string | null;
  readonly role: UserRole;
}

/** A pending invite, claimed for accepting. */
export interface ClaimedInvite {
  readonly id: string;
  readonly email: string | null;
  readonly role: UserRole;
  readonly teamIds: readonly string[];
  readonly invitedById: string;
}

export interface NewMember {
  readonly invite: ClaimedInvite;
  readonly email: string;
  readonly name: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly passwordHash: string;
}

/** A unique email or display name taken between the check and the insert (a race). */
export class TakenError extends Error {
  constructor(readonly field: 'email' | 'displayName') {
    super(`${field} taken`);
  }
}

export interface InviteStore {
  /** The pending invite whose token has this hash, as the page shows it. */
  pendingInvite(db: Db, tokenHash: string, now: Date): Promise<InviteDetails | undefined>;
  /** Marks the invite accepted if it is still pending (one caller wins), locking its row. */
  claim(db: Db, tokenHash: string, now: Date): Promise<ClaimedInvite | undefined>;
  /** Whether any user, deactivated ones included, has this (normalised) email (E3). */
  emailTaken(db: Db, email: string): Promise<boolean>;
  /** Display names that start with `prefix`, any case: the taken one and its variants (E5). */
  displayNamesLike(db: Db, prefix: string): Promise<string[]>;
  /** The user, their preferences, password and memberships, plus the events. */
  createMember(
    db: Db,
    member: NewMember,
    now: Date,
  ): Promise<{ userId: string; teamIds: string[] }>;
  createSession(db: Db, session: NewSession): Promise<CreatedSession>;
  endSessions(db: Db, userId: string, which: SessionSelection): Promise<string[]>;
}

/** A team an invite names, as it is when the invite is accepted. */
export interface InviteTeam {
  readonly id: string;
  readonly private: boolean;
  readonly archived: boolean;
  /** Whether the person who sent the invite is a member now. */
  readonly inviterIsMember: boolean;
}

/**
 * The teams the invitee joins: those still there and not archived. A private team only while the
 * inviter is still a member: they could add someone there themselves (team.addMember), and the
 * invite must not open a private team they have left, or one that turned private (D10).
 */
export function teamsToJoin(teams: readonly InviteTeam[]): string[] {
  return teams
    .filter((team) => !team.archived && (!team.private || team.inviterIsMember))
    .map((team) => team.id);
}

/** `LIKE` treats `_` and `%` as wildcards; display names may contain `_`. */
function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const PG_INVITE_STORE: InviteStore = {
  async pendingInvite(db, tokenHash, now) {
    const { rows } = await db.query<InviteDetails>(
      `SELECT w.name AS "workspaceName", u.name AS "inviterName", i.email, i.role
         FROM invites i
         JOIN users u ON u.id = i.invited_by_id
         CROSS JOIN (SELECT name FROM workspace LIMIT 1) w
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > $2`,
      [tokenHash, now],
    );
    return rows[0];
  },

  async claim(db, tokenHash, now) {
    const { rows } = await db.query<ClaimedInvite>(
      `UPDATE invites SET accepted_at = $2
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
        RETURNING id, email, role, team_ids AS "teamIds", invited_by_id AS "invitedById"`,
      [tokenHash, now],
    );
    return rows[0];
  },

  async emailTaken(db, email) {
    const { rowCount } = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    return (rowCount ?? 0) > 0;
  },

  async displayNamesLike(db, prefix) {
    const { rows } = await db.query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE lower(display_name) LIKE lower($1) ESCAPE '\\'`,
      [likePrefix(prefix)],
    );
    return rows.map((row) => row.display_name);
  },

  async createMember(db, member, now) {
    const repo = syncRepo(drizzle({ client: db, casing: 'snake_case' }), now);
    const userId = uuidv7();
    try {
      await repo.insert('User', {
        id: userId,
        email: member.email,
        name: member.name,
        displayName: member.displayName,
        timezone: member.timezone,
        role: member.invite.role,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_idx')) throw new TakenError('email');
      if (isUniqueViolation(error, 'users_display_name_idx')) throw new TakenError('displayName');
      throw error;
    }
    await repo.insert('UserPreferences', { id: userId });

    const { rows: teams } = await db.query<InviteTeam>(
      `SELECT t.id, t.private, t.archived_at IS NOT NULL AS archived,
              EXISTS (SELECT 1 FROM team_memberships m
                       WHERE m.team_id = t.id AND m.user_id = $2) AS "inviterIsMember"
         FROM teams t
        WHERE t.id = ANY($1::uuid[])
        ORDER BY t.id
          FOR SHARE OF t`,
      [member.invite.teamIds, member.invite.invitedById],
    );
    const teamIds = teamsToJoin(teams);
    for (const teamId of teamIds) {
      await repo.insert('TeamMembership', { id: uuidv7(), teamId, userId });
    }
    const flushed = await repo.flush({});

    await db.query(
      'INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES ($1, $2, $3)',
      [userId, member.passwordHash, now],
    );
    // The events the executor would write for an operation (events.md), by the new user.
    const actor = { kind: 'user', userId };
    await drizzle({ client: db, casing: 'snake_case' })
      .insert(eventOutbox)
      .values([
        {
          id: uuidv7(),
          type: 'user.joined',
          occurredAt: now,
          actor,
          subject: { type: 'user', id: userId },
          data: {
            reason: 'invite',
            inviteId: member.invite.id,
            invitedById: member.invite.invitedById,
          },
          lastSyncId: flushed.lastSyncId ?? null,
        },
        ...teamIds.map((teamId) => ({
          id: uuidv7(),
          type: 'team.member_added',
          occurredAt: now,
          actor,
          subject: { type: 'team', id: teamId },
          data: { userId },
          lastSyncId: flushed.lastSyncId ?? null,
        })),
      ]);
    return { userId, teamIds };
  },

  createSession,
  endSessions: deleteUserSessions,
};
