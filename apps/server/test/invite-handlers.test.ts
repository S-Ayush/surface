// PLAN-001 S5: the invite operations (SPEC-001 §3.4, §6.2, E3, E7/D7) on a fake transaction,
// `invite.list`'s paging in memory, the teams an accepted invite joins, and `InviteRef`'s lookup.
// Their SQL against Postgres was checked by hand (integration tests are held, plans README §6).
import { EMAIL_TAKEN_MESSAGE, userActor, type UserRole } from '@surface/domain';
import {
  evaluatePermission,
  inviteCreate,
  inviteList,
  inviteRevoke,
  type AnyOperation,
} from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { invites, users, workspace } from '../src/db/schema/index.js';
import type { DomainEvent, HandlerContext } from '../src/executor/context.js';
import { teamIdOf } from '../src/executor/key-scope.js';
import { lookup } from '../src/executor/refs/sources.js';
import create from '../src/handlers/invites/create.js';
import { invitePage } from '../src/handlers/invites/list-model.js';
import revoke from '../src/handlers/invites/revoke.js';
import { teamsToJoin } from '../src/handlers/invites/store.js';
import { handlerLinks, hashLinkToken } from '../src/mail/link-tokens.js';

const ADA = '0190f000-0000-7000-8000-000000000001';
const ENG = '0190f000-0000-7000-8000-0000000000e1';
const INVITE = '0190f000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-11-12T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

type InviteRow = typeof invites.$inferSelect;

function inviteRow(patch: Partial<InviteRow> = {}): InviteRow {
  return {
    id: INVITE,
    email: 'zoe@example.com',
    tokenHash: 'hash',
    role: 'member',
    teamIds: [],
    invitedById: ADA,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    acceptedAt: null,
    revokedAt: null,
    ...patch,
  };
}

/**
 * A handler context over a fake transaction. Selects answer by table: `users` (an account with
 * the email, or none), `workspace` (its name), `invites` (`stored`). Inserts and updates of
 * `invites` are applied to `stored` and recorded, as are events, emails and audit lines.
 */
function fakeCtx(options: { emailTaken?: boolean; smtp?: boolean; stored?: InviteRow } = {}) {
  let stored = options.stored;
  const writes: string[] = [];
  const events: DomainEvent[] = [];
  const emails: unknown[] = [];
  const audited: unknown[] = [];
  const rowsOf = (table: unknown): unknown[] => {
    if (table === users) return options.emailTaken ? [{ id: 'someone' }] : [];
    if (table === workspace) return [{ name: 'Acme' }];
    if (table === invites) return stored ? [stored] : [];
    throw new Error('unexpected table');
  };
  const chain = (rows: () => unknown[]) => {
    const builder = {
      where: () => builder,
      limit: () => builder,
      for: (strength: string) => {
        writes.push(`lock ${strength}`);
        return builder;
      },
      returning: () => builder,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
    };
    return builder;
  };
  const tx = {
    select: () => ({ from: (table: unknown) => chain(() => rowsOf(table)) }),
    insert: (table: unknown) => ({
      values: (values: Omit<InviteRow, 'acceptedAt' | 'revokedAt'>) => {
        if (table !== invites) throw new Error('unexpected insert');
        writes.push('insert invite');
        // As Postgres returns it: the columns the insert leaves out are null.
        stored = { ...values, acceptedAt: null, revokedAt: null };
        return chain(() => [stored]);
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Partial<InviteRow>) => {
        if (table !== invites || !stored) throw new Error('unexpected update');
        writes.push(`update invite ${Object.keys(patch).join(',')}`);
        stored = { ...stored, ...patch };
        return chain(() => [stored]);
      },
    }),
  };
  const ctx = {
    actor: { kind: 'user', userId: ADA },
    refs: { teams: [{ id: ENG }, { id: ENG }], invite: { id: INVITE } },
    tx,
    now: () => NOW,
    query: { get: () => Promise.resolve({ id: ADA, name: 'Ada Lovelace' }) },
    links: handlerLinks(
      { query: () => Promise.reject(new Error('no queries')) },
      'https://s.example.com',
      NOW,
    ),
    enqueueEmail: (email: unknown) => {
      if (options.smtp === false) return Promise.resolve(false);
      emails.push(email);
      return Promise.resolve(true);
    },
    emit: (event: DomainEvent) => void events.push(event),
    audit: (event: string, fields: object, message: string) =>
      void audited.push({ event, ...fields, message }),
  } as unknown as HandlerContext;
  return { ctx, writes, events, emails, audited, stored: () => stored };
}

describe('invite.create (SPEC-001 §3.4)', () => {
  it('stores the invite with its link’s hash, emails it, and returns the link once', async () => {
    const { ctx, emails, events, audited, stored } = fakeCtx();
    const result = inviteCreate.output.parse(
      await create.run(ctx, { email: 'zoe@example.com', role: 'member', teams: ['ENG', 'eng'] }),
    );
    expect(result.url).toMatch(/^https:\/\/s\.example\.com\/invite\/[\w-]{43}$/);
    expect(result.emailed).toBe(true);
    const token = decodeURIComponent(result.url.split('/').at(-1) ?? '');
    // Only the hash is stored: the link can't be shown again.
    expect(stored()?.tokenHash).toBe(hashLinkToken(token));
    expect(result.invite).toMatchObject({
      email: 'zoe@example.com',
      role: 'member',
      teamIds: [ENG],
      invitedById: ADA,
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    });
    expect(emails).toEqual([
      {
        template: 'invite',
        to: 'zoe@example.com',
        workspaceName: 'Acme',
        inviterName: 'Ada Lovelace',
        link: result.url,
      },
    ]);
    expect(events).toEqual([
      {
        type: 'user.invited',
        subject: { type: 'invite', id: result.invite.id },
        data: { role: 'member', teamIds: [ENG] },
      },
    ]);
    // SPEC-001 §10: ids only, written once the attempt commits.
    expect(audited).toEqual([{ event: 'user.invited', actorId: ADA, message: 'invite created' }]);
  });

  it('says it emailed nothing without SMTP or without an email, and still returns the link (AC-3)', async () => {
    const noSmtp = fakeCtx({ smtp: false });
    const a = await create.run(noSmtp.ctx, { email: 'zoe@example.com', role: 'admin', teams: [] });
    expect(a.emailed).toBe(false);
    const noEmail = fakeCtx();
    const b = await create.run(noEmail.ctx, { role: 'member', teams: [] });
    expect([b.emailed, b.invite.email, noEmail.emails]).toEqual([false, null, []]);
    expect(b.url).toContain('/invite/');
  });

  it('refuses an email that already has an account, storing nothing (E3)', async () => {
    const { ctx, writes, events } = fakeCtx({ emailTaken: true });
    await expect(
      create.run(ctx, { email: 'iris@example.com', role: 'member', teams: [] }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: EMAIL_TAKEN_MESSAGE,
      // On the email field, so the modal shows it there whatever its words.
      details: { issues: [{ path: ['email'], message: EMAIL_TAKEN_MESSAGE }] },
    });
    expect([writes, events]).toEqual([[], []]);
  });

  it('normalises the email it is given (E2)', () => {
    const parsed = inviteCreate.input.parse({ email: '  Zoe@Example.COM ' });
    expect(parsed).toEqual({ email: 'zoe@example.com', role: 'member', teams: [] });
    expect(inviteCreate.input.safeParse({ email: 'zoe' }).error?.issues[0]?.message).toBe(
      'Email must look like name@example.com',
    );
  });
});

describe('invite.revoke (SPEC-001 §3.4 step 5)', () => {
  it('turns off a pending invite, under its row lock', async () => {
    const { ctx, writes } = fakeCtx({ stored: inviteRow() });
    const result = await revoke.run(ctx, { invite: INVITE });
    expect(result.status).toBe('revoked');
    expect(writes).toEqual(['lock update', 'update invite revokedAt']);
  });

  it('changes nothing for a revoked or expired invite', async () => {
    for (const row of [inviteRow({ revokedAt: NOW }), inviteRow({ expiresAt: NOW })]) {
      const { ctx, writes } = fakeCtx({ stored: row });
      const result = await revoke.run(ctx, { invite: INVITE });
      expect(['revoked', 'expired']).toContain(result.status);
      expect(writes).toEqual(['lock update']);
    }
  });

  it('refuses an accepted invite, and says what to do instead', async () => {
    const { ctx } = fakeCtx({ stored: inviteRow({ acceptedAt: NOW }) });
    await expect(revoke.run(ctx, { invite: INVITE })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This invite was already accepted. Change the person’s role in Members instead.',
    });
  });
});

describe('who may run the invite operations (AC-14, permissions.md §3.1)', () => {
  const allowed = (op: AnyOperation, role: UserRole) =>
    evaluatePermission(op, userActor({ userId: ADA, role, memberships: [] }), {}, {}).allowed;

  it('lets only Admins invite, list and revoke', () => {
    for (const op of [inviteCreate, inviteList, inviteRevoke]) {
      expect([allowed(op, 'admin'), allowed(op, 'member')]).toEqual([true, false]);
    }
  });
});

describe('invite.list paging in memory (SPEC-003 §7.1)', () => {
  const node = (n: number, patch: Record<string, unknown> = {}) => ({
    id: `0190f000-0000-7000-8000-00000000000${n}`,
    email: `p${n}@example.com`,
    role: 'member' as const,
    teamIds: [],
    invitedById: ADA,
    status: 'pending' as const,
    createdAt: new Date(NOW.getTime() - n * DAY).toISOString(),
    expiresAt: new Date(NOW.getTime() + n * DAY).toISOString(),
    ...patch,
  });
  const all = [node(1), node(2, { status: 'revoked' }), node(3, { email: null }), node(4)];
  const ctx = { now: NOW, me: ADA };

  it('lists newest first by default, and filters with the shared evaluator', () => {
    const page = invitePage(all, { limit: 25 }, ctx);
    expect(page.nodes.map((n) => n.id)).toEqual(all.map((n) => n.id));
    const pending = invitePage(
      all,
      { limit: 25, filter: { field: 'status', op: 'eq', value: 'pending' } },
      ctx,
    );
    expect(pending.nodes.map((n) => n.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('pages with a keyset cursor, never repeating or skipping, with nulls last', () => {
    const seen: (string | null)[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = invitePage(
        all,
        { limit: 1, orderBy: { field: 'email', direction: 'desc' }, ...(cursor ? { cursor } : {}) },
        ctx,
      );
      seen.push(...page.nodes.map((n) => n.email));
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor ?? undefined;
    }
    expect(seen).toEqual(['p4@example.com', 'p2@example.com', 'p1@example.com', null]);
  });

  it('refuses an unknown sort, a bad filter field, or a cursor from another sort', () => {
    expect(() => invitePage(all, { limit: 5, orderBy: { field: 'role' } }, ctx)).toThrow(
      'Can\'t sort invites by "role". Use one of: createdAt, expiresAt, email.',
    );
    expect(() =>
      invitePage(all, { limit: 5, filter: { field: 'team', op: 'eq', value: 'x' } }, ctx),
    ).toThrow(/Unknown filter field "team"/);
    const cursor = invitePage(all, { limit: 1 }, ctx).pageInfo.endCursor ?? '';
    expect(() => invitePage(all, { limit: 1, cursor, orderBy: { field: 'email' } }, ctx)).toThrow(
      'This cursor is not from this list and sort. Start again without it.',
    );
    expect(() => invitePage(all, { limit: 1, cursor: 'nonsense' }, ctx)).toThrow(/cursor/);
  });
});

describe('teams an accepted invite joins (D10)', () => {
  const team = (id: string, patch: Partial<Parameters<typeof teamsToJoin>[0][0]> = {}) => ({
    id,
    private: false,
    archived: false,
    inviterIsMember: false,
    ...patch,
  });

  it('joins public teams, and private ones only while the inviter is still a member', () => {
    expect(
      teamsToJoin([
        team('public'),
        team('archived', { archived: true }),
        team('private-mine', { private: true, inviterIsMember: true }),
        team('private-left', { private: true }),
      ]),
    ).toEqual(['public', 'private-mine']);
  });
});

describe('InviteRef (SPEC-003 §4, PLAN-001 S5)', () => {
  const actor = { kind: 'user' as const, userId: ADA, groups: ['workspace'] };
  const db = (rows: { id: string }[]) => ({
    calls: [] as unknown[][],
    query(sql: string, params: unknown[]) {
      this.calls.push([sql, params]);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  });

  it('resolves an invite by id, in any of its states', async () => {
    const found = db([{ id: INVITE }]);
    const row = await lookup('InviteRef', INVITE.toUpperCase(), {
      db: found as never,
      actor,
      path: ['invite'],
      allowInactive: false,
    });
    expect(row).toEqual({ id: INVITE });
    expect(found.calls).toEqual([['SELECT id FROM invites WHERE id = $1', [INVITE]]]);
  });

  it('is NOT_FOUND for an unknown id, saying where ids come from', async () => {
    await expect(
      lookup('InviteRef', INVITE, {
        db: db([]) as never,
        actor,
        path: ['invite'],
        allowInactive: false,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `Invite "${INVITE}" not found. Use an invite id from invite.list.`,
    });
  });

  it('is workspace-wide, so an API key’s team limit doesn’t narrow it', () => {
    expect(teamIdOf('InviteRef', { id: INVITE })).toBeNull();
  });
});
