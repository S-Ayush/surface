/**
 * The seed fixture that operation examples run against (SPEC-003 §11 rule 2). Examples name
 * things the way people do ("ENG", "me", "iris@example.com"), so the seed must hold what they
 * name. Each plan adds what its examples name.
 *
 * PLAN-001 S8: the actor (an Admin and a member of ENG), team ENG with its workflow, and a
 * second user, Iris. Written through the repo, like the handlers write. Seeded once per
 * database, and examples run in registry order, so they share it: an example that changes a
 * row changes it for the ones after (`team.update` renames ENG; `team.leave` then `team.join`
 * leave the actor a member, as the actor's `memberships` say).
 *
 * PLAN-001 S7: the workspace (`workspace.get`, `workspace.update` renames it). The `user.setRole`
 * examples make Iris an Admin and then a Member again.
 *
 * PLAN-001 S5 (session E): a pending invite with a fixed id, which the `invite.revoke` example
 * revokes. `invite.create`'s example invites new.person@example.com, who has no account.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
import { syncRepo } from '../src/sync/repo.js';
import type { TestDatabase } from './db.js';
import { actorFor } from './helpers.js';

export interface SeedFixture {
  /** Who runs the examples: an Admin, so permission checks pass where the data allows. */
  readonly actor: Actor;
  readonly users: { readonly me: string; readonly iris: string };
  readonly teams: { readonly eng: string };
}

/** The pending invite `invite.revoke`'s example names (`packages/operations/src/ops/invite.ts`). */
export const SEED_INVITE_ID = '01930000-0000-7000-8000-000000000501';

const seeded = new WeakMap<TestDatabase, Promise<SeedFixture>>();

export function seedFixture(db: TestDatabase): Promise<SeedFixture> {
  let fixture = seeded.get(db);
  if (!fixture) {
    fixture = seed(db);
    seeded.set(db, fixture);
  }
  return fixture;
}

async function seed(db: TestDatabase): Promise<SeedFixture> {
  const users = { me: randomUUID(), iris: randomUUID() };
  const teams = { eng: randomUUID() };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await repo.insert('Workspace', { id: randomUUID(), name: 'Surface', syncGroups: [] });
    await repo.insert('User', {
      id: users.me,
      email: 'ada@example.com',
      name: 'Ada Admin',
      displayName: 'ada',
      role: 'admin',
      syncGroups: [],
    });
    await repo.insert('User', {
      id: users.iris,
      email: 'iris@example.com',
      name: 'Iris',
      displayName: 'iris',
      syncGroups: [],
    });
    const workflow = teamWorkflow(teams.eng);
    await repo.insert('Team', {
      id: teams.eng,
      key: 'ENG',
      name: 'Engineering',
      defaultStatusId: workflow.defaultStatusId,
      syncGroups: [],
    });
    await seedTeamWorkflow(repo, workflow);
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: teams.eng,
      userId: users.me,
      syncGroups: [],
    });
    await repo.flush({});
    // Server-only, so plain SQL. The id is the one `invite.revoke`'s example names.
    await client.query(
      `INSERT INTO invites (id, email, token_hash, role, invited_by_id, expires_at)
       VALUES ($1, 'pending.person@example.com', $2, 'member', $3, now() + interval '7 days')`,
      [SEED_INVITE_ID, randomUUID(), users.me],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const actor = actorFor({
    id: users.me,
    role: 'admin',
    memberships: [{ teamId: teams.eng, private: false }],
  });
  return { actor, users, teams };
}
