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
 *
 * PLAN-011 S4: issues ENG-1 to ENG-3; the issue examples read them and `issue.update` edits ENG-1.
 *
 * PLAN-013 S3: on ENG-1, a thread of the actor's with a reply by Iris (`SEED_COMMENTS.thread`), a
 * thread of Iris's the actor resolved, and a comment of the actor's with no replies. The comment
 * examples run in registry order: edit and resolve the first thread, reopen the second, delete the
 * last comment.
 *
 * PLAN-001 S6 (session E, agreed with A): the actor's password and a second session of theirs.
 * `session.revoke`'s example ends that session, and `user.changePassword`'s example changes the
 * password from `SEED_PASSWORD`.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { docToText, markdownToDoc } from '@surface/editor/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
import { newIssuePosition } from '../src/issues/numbering.js';
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

/** The session `session.revoke`'s example names (`packages/operations/src/ops/session.ts`). */
export const SEED_SESSION_ID = '01930000-0000-7000-8000-000000000601';

/**
 * The comments the comment examples name (`packages/operations/src/ops/comment.ts`), on ENG-1.
 * Ids in creation order, so `comment.list` lists them in this order.
 */
export const SEED_COMMENTS = {
  thread: '01930000-0000-7000-8000-000000000701',
  reply: '01930000-0000-7000-8000-000000000702',
  resolvedThread: '01930000-0000-7000-8000-000000000703',
  single: '01930000-0000-7000-8000-000000000704',
} as const;

/**
 * The actor's password, which `user.changePassword`'s example gives as the current one. Test
 * only: it never ships (this file is outside `src/`), and it guards nothing.
 */
export const SEED_PASSWORD = 'seed-password-not-secret';
/** argon2id of `SEED_PASSWORD`, computed once so seeding does no hashing. */
const SEED_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ILoquvZtUDFkYznV2ZZTVQ$vmKgU2G0VG8bHpy7GgrQJQrob4gcMjEAK3amW3vJvaQ';

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
    const tx = drizzle({ client, casing: 'snake_case' });
    const repo = syncRepo(tx, new Date());
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
    const statuses = await seedTeamWorkflow(repo, workflow);
    await repo.insert('TeamMembership', {
      id: randomUUID(),
      teamId: teams.eng,
      userId: users.me,
      syncGroups: [],
    });
    // PLAN-011 S4: ENG-1 to ENG-3, numbered and ordered like `issue.create` does.
    const issueIds: string[] = [];
    const statusNamed = (name: string) => {
      const status = statuses.find((s) => s.name === name);
      if (!status) throw new Error(`The seed workflow has no ${name} status`);
      return status.id;
    };
    for (const [title, status, assigneeId] of [
      ['Fix the login redirect loop', 'Todo', null],
      ['Add keyboard shortcuts to the issue list', 'In Progress', users.me],
      ['Write the onboarding guide', 'Backlog', users.iris],
    ] as const) {
      const { number, sortOrder } = await newIssuePosition(tx, teams.eng);
      issueIds.push(
        (
          await repo.insert('Issue', {
            id: randomUUID(),
            teamId: teams.eng,
            number,
            title,
            statusId: statusNamed(status),
            assigneeId,
            sortOrder,
            creatorId: users.me,
            startedAt: status === 'In Progress' ? new Date() : null,
          })
        ).id,
      );
    }
    // PLAN-013 S3: comments on ENG-1. The repo gives them one `createdAt`, so `comment.list`
    // orders them by id, their creation order.
    const eng1 = issueIds[0];
    if (eng1 === undefined) throw new Error('The seed has no ENG-1');
    for (const [id, userId, parentCommentId, text, resolvedById] of [
      [SEED_COMMENTS.thread, users.me, null, 'Does this happen on **Firefox** too?', null],
      [SEED_COMMENTS.reply, users.iris, SEED_COMMENTS.thread, 'Yes, on 132 and later.', null],
      [
        SEED_COMMENTS.resolvedThread,
        users.iris,
        null,
        'The redirect comes from the proxy.',
        users.me,
      ],
      [SEED_COMMENTS.single, users.me, null, 'Moving this to next week.', null],
    ] as const) {
      const body = markdownToDoc(text);
      await repo.insert('Comment', {
        id,
        issueId: eng1,
        teamId: teams.eng,
        parentCommentId,
        userId,
        actorKind: 'user',
        body,
        version: 1,
        resolvedAt: resolvedById === null ? null : new Date(),
        resolvedById,
      });
      await client.query('INSERT INTO comment_search_text (comment_id, text) VALUES ($1, $2)', [
        id,
        docToText(body),
      ]);
    }
    await repo.flush({});
    // Server-only, so plain SQL. The id is the one `invite.revoke`'s example names.
    await client.query(
      `INSERT INTO invites (id, email, token_hash, role, invited_by_id, expires_at)
       VALUES ($1, 'pending.person@example.com', $2, 'member', $3, now() + interval '7 days')`,
      [SEED_INVITE_ID, randomUUID(), users.me],
    );
    await client.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [
      users.me,
      SEED_PASSWORD_HASH,
    ]);
    await client.query(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
       VALUES ($1, $2, $3, 'Seed browser', now() + interval '30 days')`,
      [SEED_SESSION_ID, users.me, randomUUID()],
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
    // ENG is public, as a real actor's `publicTeams` says (SPEC-011 §5.6): comments are in
    // `team:<id>` only (SPEC-013 D12), so without it the actor would see none.
    publicTeams: [teams.eng],
  });
  return { actor, users, teams };
}
