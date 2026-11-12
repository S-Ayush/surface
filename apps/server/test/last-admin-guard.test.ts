// PLAN-001 S7: `user.setRole` never leaves the workspace without an active Admin (INV-01,
// SPEC-001 AC-10, E6), and the member and workspace operations are for the roles SPEC-001 §6.2
// gives them (AC-14, unit part). The handler runs on a fake transaction here; its SQL against
// Postgres, two Admins demoting each other at once included, was checked by hand (integration
// tests are held, plans README §6).
import { LAST_ADMIN_MESSAGE, leavesNoAdmin, userActor, type UserRole } from '@surface/domain';
import {
  evaluatePermission,
  userGet,
  userList,
  userSetRole,
  workspaceGet,
  workspaceUpdate,
  type AnyOperation,
} from '@surface/operations';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DomainEvent, HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import setRole from '../src/handlers/members/set-role.js';

const ADA = '0190f000-0000-7000-8000-000000000001';
const IRIS = '0190f000-0000-7000-8000-000000000002';
const BEA = '0190f000-0000-7000-8000-000000000003';

describe('leavesNoAdmin (INV-01)', () => {
  it('refuses demoting the only Admin', () => {
    expect(leavesNoAdmin([ADA], ADA, 'member')).toBe(true);
  });

  it('allows demoting an Admin while another stays', () => {
    expect(leavesNoAdmin([ADA, IRIS], ADA, 'member')).toBe(false);
  });

  it('always allows a promotion, and a change to someone who is not an active Admin', () => {
    expect(leavesNoAdmin([ADA], ADA, 'admin')).toBe(false);
    expect(leavesNoAdmin([ADA], IRIS, 'member')).toBe(false);
    expect(leavesNoAdmin([ADA], IRIS, 'admin')).toBe(false);
  });

  it('keeps at least one Admin through any sequence of the changes it allows', () => {
    const people = [ADA, IRIS, BEA];
    const change = fc.record({
      user: fc.constantFrom(...people),
      role: fc.constantFrom<UserRole>('admin', 'member'),
    });
    fc.assert(
      fc.property(
        fc.subarray(people, { minLength: 1 }),
        fc.array(change, { maxLength: 30 }),
        (start, changes) => {
          const admins = new Set(start);
          for (const { user, role } of changes) {
            if (leavesNoAdmin([...admins], user, role)) continue;
            if (role === 'admin') admins.add(user);
            else admins.delete(user);
            expect(admins.size).toBeGreaterThan(0);
          }
        },
      ),
    );
  });
});

type Row = { id: string; role: UserRole };

/**
 * A handler context over a fake transaction: the active Admins the lock returns, the users the
 * visibility-checked read finds, and a record of the calls in order (lock, read, write) and of
 * events. The fake ignores the WHERE clause: which rows count as active Admins is SQL, checked
 * by hand (PLAN-001 S7 As built) until the held integration test.
 */
function fakeCtx(people: readonly Row[]) {
  const calls: string[] = [];
  const events: DomainEvent[] = [];
  /** `ctx.audit` calls; the executor writes them once the attempt commits (its own tests). */
  const audited: Record<string, unknown>[] = [];
  const at = new Date('2026-11-07T12:00:00Z');
  const full = (row: Row) => ({
    ...row,
    email: `${row.id}@example.com`,
    name: 'Someone',
    displayName: `u${row.id.slice(-1)}`,
    avatarFileId: null,
    timezone: 'UTC',
    active: true,
    createdAt: at,
    updatedAt: at,
  });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            for: (strength: string) => {
              calls.push(`lock ${strength}`);
              return Promise.resolve(
                people.filter((p) => p.role === 'admin').map((p) => ({ id: p.id })),
              );
            },
          }),
        }),
      }),
    }),
  };
  /** The context for a change to `userId`, run by `actorId` (null: the system actor). */
  const ctx = (userId: string, actorId: string | null = ADA) =>
    ({
      actor: { userId: actorId ?? undefined },
      refs: { user: { id: userId } },
      tx,
      query: {
        get: (_model: string, id: string) => {
          calls.push(`read ${id}`);
          const row = people.find((p) => p.id === id);
          return Promise.resolve(row && full(row));
        },
      },
      repo: {
        update: (_model: string, id: string, patch: { role: UserRole }) => {
          calls.push(`write ${id} ${patch.role}`);
          const row = people.find((p) => p.id === id);
          if (row === undefined) throw new Error('no such row');
          return Promise.resolve(full({ ...row, ...patch }));
        },
      },
      emit: (event: DomainEvent) => {
        events.push(event);
      },
      audit: (event: string, fields: object, msg: string) => {
        audited.push({ event, ...fields, msg });
      },
    }) as unknown as HandlerContext;
  const writes = () => calls.filter((call) => call.startsWith('write'));
  const audits = () => audited;
  return { ctx, calls, writes, events, audits };
}

describe('user.setRole (AC-10, E6)', () => {
  it('refuses to demote the last active Admin, with CONFLICT and what to do, writing nothing', async () => {
    const { ctx, calls, writes, events } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'member' },
    ]);
    const refusal = setRole.run(ctx(ADA), { user: ADA, role: 'member' });
    await expect(refusal).rejects.toBeInstanceOf(SurfaceError);
    await expect(refusal).rejects.toMatchObject({ code: 'CONFLICT', message: LAST_ADMIN_MESSAGE });
    expect(LAST_ADMIN_MESSAGE).toMatch(/^Surface needs at least one Admin\./);
    expect(writes()).toEqual([]);
    expect(events).toEqual([]);
    // Counted under a row lock taken before the user is read, so concurrent demotions can't both
    // pass and the read sees the other's committed change.
    expect(calls).toEqual(['lock no key update', `read ${ADA}`]);
  });

  it('demotes an Admin while another stays, and reports the change', async () => {
    const { ctx, writes, events } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'admin' },
    ]);
    const result = userSetRole.output.parse(
      await setRole.run(ctx(ADA), { user: ADA, role: 'member' }),
    );
    expect(result.role).toBe('member');
    expect(writes()).toEqual([`write ${ADA} member`]);
    expect(events).toEqual([
      {
        type: 'user.role_changed',
        subject: { type: 'user', id: ADA },
        changes: { role: { from: 'admin', to: 'member' } },
      },
    ]);
  });

  it('promotes a Member', async () => {
    const { ctx, writes } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'member' },
    ]);
    const result = await setRole.run(ctx(IRIS), { user: IRIS, role: 'admin' });
    expect(result.role).toBe('admin');
    expect(writes()).toEqual([`write ${IRIS} admin`]);
  });

  it('changes nothing when the user already has the role, even the last Admin', async () => {
    const { ctx, writes, events } = fakeCtx([{ id: ADA, role: 'admin' }]);
    const result = await setRole.run(ctx(ADA), { user: ADA, role: 'admin' });
    expect(result.role).toBe('admin');
    expect(writes()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses an actor who is no longer an Admin once the lock is theirs (a request in flight)', async () => {
    // Bea was demoted while her own request waited on the lock; it must not undo the demotion.
    const { ctx, calls, events } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: BEA, role: 'member' },
    ]);
    const refusal = setRole.run(ctx(BEA, BEA), { user: BEA, role: 'admin' });
    await expect(refusal).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only Admins can change a user’s role.',
    });
    expect(calls).toEqual(['lock no key update']);
    expect(events).toEqual([]);
  });

  it('lets the system actor, which has no user row, change roles', async () => {
    const { ctx, writes } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'member' },
    ]);
    await setRole.run(ctx(IRIS, null), { user: IRIS, role: 'admin' });
    expect(writes()).toEqual([`write ${IRIS} admin`]);
  });
});

describe('user.setRole audit line (SPEC-001 §10)', () => {
  it('logs who changed whose role, from what to what, by id only', async () => {
    const { ctx, audits } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'admin' },
    ]);
    await setRole.run(ctx(ADA, IRIS), { user: ADA, role: 'member' });
    expect(audits()).toEqual([
      {
        event: 'user.role_changed',
        actorId: IRIS,
        userId: ADA,
        from: 'admin',
        to: 'member',
        msg: 'role changed',
      },
    ]);
  });

  it('names no actor for the system actor', async () => {
    const { ctx, audits } = fakeCtx([
      { id: ADA, role: 'admin' },
      { id: IRIS, role: 'member' },
    ]);
    await setRole.run(ctx(IRIS, null), { user: IRIS, role: 'admin' });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).not.toHaveProperty('actorId');
  });

  it('logs nothing when nothing changes or the change is refused', async () => {
    const { ctx, audits } = fakeCtx([{ id: ADA, role: 'admin' }]);
    await setRole.run(ctx(ADA), { user: ADA, role: 'admin' });
    await expect(setRole.run(ctx(ADA), { user: ADA, role: 'member' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(audits()).toEqual([]);
  });
});

describe('who may run the member and workspace operations (AC-14, permissions.md §3.1)', () => {
  const actor = (role: UserRole) => userActor({ userId: IRIS, role, memberships: [] });
  const allowed = (op: AnyOperation, role: UserRole, input: object) =>
    evaluatePermission(op, actor(role), { user: { id: ADA } }, input).allowed;

  it('lets only Admins change roles and the workspace', () => {
    for (const [op, input] of [
      [userSetRole, { user: ADA, role: 'admin' }],
      [workspaceUpdate, { name: 'Acme' }],
    ] as const) {
      expect(allowed(op, 'admin', input), op.name).toBe(true);
      expect(allowed(op, 'member', input), op.name).toBe(false);
    }
  });

  it('lets anyone read the people and the workspace', () => {
    for (const [op, input] of [
      [userList, {}],
      [userGet, { user: ADA }],
      [workspaceGet, {}],
    ] as const) {
      expect(allowed(op, 'member', input), op.name).toBe(true);
    }
  });
});
