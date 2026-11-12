// Leak test for a sync mutation's rejection (permissions.md §5, CLAUDE.md rule 4; not held, plans
// README §6). Since sync-protocol v0.6 a rejected mutation carries the `issues` the operations API
// returns (§4.4), and they are kept in `client_mutations` for replay. A mutation naming a row in a
// private team the user isn't in must get exactly the result a missing row gets, `issues`
// included, the first time and on replay, and must store nothing about the team beyond the
// reference the user sent.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import type { MutationResult } from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Executor } from '../src/executor/execute.js';
import { syncRepo } from '../src/sync/repo.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor } from './helpers.js';

let h: ExecutorHarness;
let executor: Executor;
const ana = randomUUID(); // member of ENG only
const sam = randomUUID(); // the only member of private SEC
let anaActor: Actor;

beforeAll(async () => {
  h = await executorHarness();
  executor = testExecutor(h.pool).executor;
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const [id, name] of [
      [ana, 'ana'],
      [sam, 'sam'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        syncGroups: [],
      });
    }
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.eng,
      userId: ana,
      syncGroups: [],
    });
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: h.teams.sec,
      userId: sam,
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
  anaActor = actorFor({ id: ana, memberships: [{ teamId: h.teams.eng, private: false }] });
});
afterAll(async () => {
  await h.close();
});

/** Runs one mutation as seq 1 of a new client, then resends it; both answers must match. */
async function rejection(op: string, input: Record<string, unknown>): Promise<MutationResult> {
  const clientId = randomUUID();
  const run = async () => {
    const outcome = await executor.executeSynced(op, input, anaActor, { clientId, seq: 1 });
    if (outcome.kind !== 'result') throw new Error(`expected a result, got ${outcome.kind}`);
    return outcome.result;
  };
  const first = await run();
  expect(await run(), 'replayed from client_mutations').toEqual(first);
  const { rows } = await h.pool.query<{ stored: string }>(
    'SELECT last_results::text AS stored FROM client_mutations WHERE client_id = $1',
    [clientId],
  );
  // What is kept is what was sent: the caller's own reference, never the team's name or key.
  const stored = rows[0]?.stored ?? '';
  expect(stored).not.toContain('Security');
  if (input['team'] !== 'SEC') expect(stored).not.toContain('SEC');
  return first;
}

/** The result with the team reference replaced, so two answers can be compared. */
function hidden(result: MutationResult, team: string): unknown {
  return JSON.parse(JSON.stringify(result).replaceAll(team, '<team>'));
}

const OPS: readonly [string, Record<string, unknown>][] = [
  ['team.update', { name: 'Renamed', color: 'red' }],
  ['team.join', {}],
  ['team.addMember', { user: 'me' }],
  ['team.removeMember', { user: 'sam@example.com' }],
];

describe('a sync mutation naming private team SEC, from a user not in it', () => {
  for (const [op, rest] of OPS) {
    it(`${op} is rejected like an unknown team, issues included, by key and by id, and on replay`, async () => {
      const byKey = await rejection(op, { team: 'SEC', ...rest });
      expect(byKey).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } });
      expect(hidden(byKey, 'SEC')).toEqual(
        hidden(await rejection(op, { team: 'ZZZ', ...rest }), 'ZZZ'),
      );
      const missing = randomUUID();
      const byId = await rejection(op, { team: h.teams.sec, ...rest });
      expect(hidden(byId, h.teams.sec)).toEqual(
        hidden(await rejection(op, { team: missing, ...rest }), missing),
      );
    });
  }

  it('gets the issues the operations API returns for the same refusal', async () => {
    const synced = await rejection('team.update', { team: 'SEC', name: 'Renamed' });
    const api = await executor.execute('team.update', { team: 'SEC', name: 'Renamed' }, anaActor);
    if (api.ok || synced.status !== 'error') throw new Error('expected both to be refused');
    expect(api.error.issues?.length).toBeGreaterThan(0);
    expect(synced.error).toEqual({
      code: api.error.code,
      message: api.error.message,
      issues: api.error.issues,
    });
  });
});
