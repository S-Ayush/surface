// PLAN-001 S5 leak test (permissions.md §5, CLAUDE.md rule 4; not held, plans README §6). An
// Admin who can't see private team SEC can't invite anyone into it: `invite.create` naming SEC
// answers exactly like one naming a team that doesn't exist, by key or by id, and stores nothing.
// Invites made by a member of SEC never show SEC's id to an Admin outside it (`invite.list`,
// `invite.revoke`). Accepting an invite joins a private team only while its inviter is a member
// (D10), so an invite can't open SEC to someone no member chose. Runs the SQL against Postgres.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { inviteCreate } from '@surface/operations';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Executor } from '../src/executor/execute.js';
import { PG_INVITE_STORE } from '../src/handlers/invites/store.js';
import { syncRepo } from '../src/sync/repo.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor } from './helpers.js';

let h: ExecutorHarness;
let executor: Executor;
const sam = randomUUID(); // an Admin, the only member of private SEC
const zoe = randomUUID(); // an Admin, member of ENG only
let zoeActor: Actor;
let samActor: Actor;

beforeAll(async () => {
  h = await executorHarness();
  executor = testExecutor(h.pool, { publicUrl: 'https://surface.example.com' }).executor;
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const [id, name] of [
      [sam, 'sam'],
      [zoe, 'zoe'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        role: 'admin',
        syncGroups: [],
      });
    }
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.sec,
      userId: sam,
      syncGroups: [],
    });
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.eng,
      userId: zoe,
      syncGroups: [],
    });
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  zoeActor = actorFor({
    id: zoe,
    role: 'admin',
    memberships: [{ teamId: h.teams.eng, private: false }],
  });
  samActor = actorFor({
    id: sam,
    role: 'admin',
    memberships: [{ teamId: h.teams.sec, private: true }],
  });
});
afterAll(async () => {
  await h.close();
});

async function inviteCount(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM invites');
  return rows[0]?.n ?? 0;
}

/** The failure, with the team reference replaced, so two answers can be compared. */
async function failure(team: string) {
  const result = await executor.execute('invite.create', { teams: ['ENG', team] }, zoeActor);
  if (result.ok) return { ok: true };
  const { code, message, issues } = result.error;
  const hide = (text: string) => text.replaceAll(team, '<team>');
  return {
    code,
    message: hide(message),
    issues: (issues ?? []).map((issue) => ({ ...issue, message: hide(issue.message) })),
  };
}

describe('an Admin who is not in private team SEC', () => {
  it('gets the unknown-team answer for an invite into SEC, by key and by id, storing nothing', async () => {
    const before = await inviteCount();
    const byKey = await failure('SEC');
    expect(byKey).toEqual(await failure('ZZZ'));
    expect(byKey).toMatchObject({ code: 'NOT_FOUND' });
    const byId = await failure(h.teams.sec);
    expect(byId).toEqual(await failure(randomUUID()));
    expect(await inviteCount()).toBe(before);
  });

  it('can invite into the teams it sees (the control)', async () => {
    const result = await executor.execute('invite.create', { teams: ['ENG'] }, zoeActor);
    expect(result).toMatchObject({ ok: true, result: { invite: { teamIds: [h.teams.eng] } } });
  });
});

describe('an invite into SEC, made by a member of SEC', () => {
  /** Sam's invite to ENG and SEC; its id. */
  async function samsInvite(): Promise<string> {
    const made = await executor.execute('invite.create', { teams: ['ENG', 'SEC'] }, samActor);
    if (!made.ok) throw new Error(made.error.message);
    return inviteCreate.output.parse(made.result).invite.id;
  }

  it('never shows SEC to an Admin outside it, in invite.list or invite.revoke', async () => {
    const id = await samsInvite();
    const listed = await executor.execute('invite.list', {}, zoeActor);
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(h.teams.sec);
    expect(JSON.stringify(listed)).toContain(id);
    const revoked = await executor.execute('invite.revoke', { invite: id }, zoeActor);
    expect(revoked).toMatchObject({ ok: true, result: { teamIds: [h.teams.eng] } });
    expect(JSON.stringify(revoked)).not.toContain(h.teams.sec);
  });

  it('shows SEC to its member (the control)', async () => {
    const id = await samsInvite();
    const listed = await executor.execute('invite.list', {}, samActor);
    expect(JSON.stringify(listed)).toContain(h.teams.sec);
    const revoked = await executor.execute('invite.revoke', { invite: id }, samActor);
    expect(JSON.stringify(revoked)).toContain(h.teams.sec);
  });
});

describe('accepting an invite that names private team SEC', () => {
  /** Accepts an invite to ENG and SEC sent by `inviter`; the teams the new user joined. */
  async function accept(inviter: string, displayName: string): Promise<string[]> {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO invites (id, token_hash, role, team_ids, invited_by_id, expires_at)
         VALUES ($1, $2, 'member', $3, $4, now() + interval '1 day') RETURNING id`,
        [randomUUID(), randomUUID(), [h.teams.eng, h.teams.sec], inviter],
      );
      const id = rows[0]?.id ?? '';
      const member = await PG_INVITE_STORE.createMember(
        client,
        {
          invite: {
            id,
            email: null,
            role: 'member',
            teamIds: [h.teams.eng, h.teams.sec],
            invitedById: inviter,
          },
          email: `${displayName}@example.com`,
          name: displayName,
          displayName,
          timezone: 'UTC',
          passwordHash: 'not-a-real-hash',
        },
        new Date(),
      );
      await client.query('COMMIT');
      const joined = await h.pool.query<{ team_id: string }>(
        'SELECT team_id FROM team_memberships WHERE user_id = $1 ORDER BY team_id',
        [member.userId],
      );
      return joined.rows.map((row) => row.team_id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('never joins SEC when the inviter is not a member of it', async () => {
    expect(await accept(zoe, 'newcomer1')).toEqual([h.teams.eng]);
  });

  it('joins SEC when the inviter is a member (the control)', async () => {
    expect((await accept(sam, 'newcomer2')).sort()).toEqual([h.teams.eng, h.teams.sec].sort());
  });
});
