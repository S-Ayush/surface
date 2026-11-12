/**
 * First-run setup in Postgres (SPEC-001 §3.1, E1, AC-2). Behind an interface so the routes and the
 * guard are unit-tested against a fake.
 *
 * Setup is an HTTP route, not an operation: there is no actor yet (server rules, "Mutations").
 * Synced rows still go through the repo, so they are logged for sync like any other write.
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { createSession, type CreatedSession } from '../auth/session.js';
import { uuidv7 } from '../db/uuidv7.js';
import { seedTeamWorkflow, seedWorkspaceLabels, teamWorkflow } from '../handlers/teams/seed.js';
import { syncRepo } from '../sync/repo.js';
import { displayNameFor, type SetupInput } from './input.js';
import { hashSetupToken, setupTokenMatches } from './token.js';

export interface SetupRequestInfo {
  readonly userAgent: string | undefined;
  readonly ip: string | undefined;
}

export type SetupOutcome =
  | {
      readonly ok: true;
      readonly session: CreatedSession;
      /** The first Admin. */
      readonly userId: string;
      readonly teamKey: string;
    }
  | { readonly ok: false; readonly reason: 'complete' | 'token' };

export interface SetupStore {
  isComplete(): Promise<boolean>;
  /** Whether `token` is the current setup token; false once setup is complete. */
  tokenValid(token: string): Promise<boolean>;
  /** Replaces the setup token. False (and nothing stored) when setup is already complete. */
  issueToken(token: string): Promise<boolean>;
  complete(input: SetupInput, request: SetupRequestInfo): Promise<SetupOutcome>;
}

interface StateRow extends Record<string, unknown> {
  token_hash: string | null;
  completed_at: Date | null;
}

export interface PgSetupStoreOptions {
  readonly now?: () => Date;
  /** Runs inside the transaction after every row is written, before COMMIT (tests only). */
  readonly beforeCommit?: () => Promise<void>;
}

const SELECT_STATE = 'SELECT token_hash, completed_at FROM setup_state WHERE id = 1';
const SELECT_STATE_FOR_UPDATE = `${SELECT_STATE} FOR UPDATE`;

export function pgSetupStore(pool: pg.Pool, options: PgSetupStoreOptions = {}): SetupStore {
  const now = options.now ?? (() => new Date());

  async function state(db: pg.Pool | pg.PoolClient, forUpdate = false): Promise<StateRow> {
    const { rows } = await db.query<StateRow>(forUpdate ? SELECT_STATE_FOR_UPDATE : SELECT_STATE);
    const row = rows[0];
    if (!row) throw new Error('setup_state has no row. Migration 0007 seeds it');
    return row;
  }

  return {
    async isComplete() {
      return (await state(pool)).completed_at !== null;
    },

    async tokenValid(token) {
      const row = await state(pool);
      return row.completed_at === null && setupTokenMatches(row.token_hash, token);
    },

    async issueToken(token) {
      const result = await pool.query(
        `UPDATE setup_state SET token_hash = $1, updated_at = now()
          WHERE id = 1 AND completed_at IS NULL`,
        [hashSetupToken(token)],
      );
      return result.rowCount === 1;
    },

    async complete(input, request) {
      // Hashing takes tens of milliseconds; do it before taking the lock.
      const passwordHash = await hashPassword(input.admin.password);
      const client = await pool.connect();
      let healthy = true;
      // pg-pool listens for errors only on idle clients. A connection that dies between this
      // transaction's statements would otherwise be an uncaught 'error' that ends the process;
      // with a listener, the next statement fails instead and the transaction is rolled back.
      const onError = () => {
        healthy = false;
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        // E1: the row lock makes concurrent setups queue; the second sees `completed_at`.
        const row = await state(client, true);
        if (row.completed_at !== null) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'complete' };
        }
        if (!setupTokenMatches(row.token_hash, input.token)) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'token' };
        }

        const at = now();
        const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), at);
        const timezone = input.admin.timezone ?? 'UTC';
        await repo.insert('Workspace', {
          id: uuidv7(),
          name: input.workspace.name,
        });
        const userId = uuidv7();
        await repo.insert('User', {
          id: userId,
          email: input.admin.email,
          name: input.admin.name,
          displayName: displayNameFor(input.admin.name, input.admin.email),
          timezone,
          role: 'admin',
        });
        await repo.insert('UserPreferences', { id: userId });
        await seedWorkspaceLabels(repo);
        const teamId = uuidv7();
        const workflow = teamWorkflow(teamId);
        // The same settings as `team.create` (PLAN-001 S8).
        await repo.insert('Team', {
          ...NEW_TEAM_SETTINGS,
          id: teamId,
          key: input.team.key,
          name: input.team.name,
          timezone,
          defaultStatusId: workflow.defaultStatusId,
        });
        await seedTeamWorkflow(repo, workflow);
        await repo.insert('TeamMembership', {
          id: uuidv7(),
          teamId,
          userId,
        });
        await repo.flush({});

        // Server-only tables, outside the repo (they are not synced).
        await client.query(
          'INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES ($1, $2, $3)',
          [userId, passwordHash, at],
        );
        await client.query(
          `UPDATE setup_state SET completed_at = $1, token_hash = NULL, updated_at = $1 WHERE id = 1`,
          [at],
        );
        const session = await createSession(client, { userId, ...request, now: at });
        await options.beforeCommit?.();
        await client.query('COMMIT');
        return { ok: true, session, userId, teamKey: input.team.key };
      } catch (error) {
        healthy = await client.query('ROLLBACK').then(
          () => true,
          () => false,
        );
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(!healthy);
      }
    },
  };
}
