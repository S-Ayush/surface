// PLAN-001 S6, SPEC-001 §3.5, §6.2, E5, E10, AC-8: the account operations on a fake transaction
// (the unit parts; AC-15's e2e test is held, plans README §6). Who may name which session or file
// is the resolvers' (SessionRef, FileRef), tested here too; their SQL ran in the registry contract
// test and was checked by hand.
import { userActor } from '@surface/domain';
import {
  sessionList as sessionListOp,
  userChangePassword as changePasswordOp,
  userUpdateProfile as updateProfileOp,
  workspaceUpdate as workspaceUpdateOp,
} from '@surface/operations';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { AttemptStore } from '../src/auth/attempts.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import type { SessionSelection } from '../src/auth/store.js';
import { sessions, userCredentials, users, workspace } from '../src/db/schema/index.js';
import type { DomainEvent, HandlerContext } from '../src/executor/context.js';
import { teamIdOf } from '../src/executor/key-scope.js';
import { lookup } from '../src/executor/refs/sources.js';
import listSessions from '../src/handlers/sessions/list.js';
import revokeOthers from '../src/handlers/sessions/revoke-others.js';
import revokeSession from '../src/handlers/sessions/revoke.js';
import changePassword, { WRONG_CURRENT_PASSWORD } from '../src/handlers/users/change-password.js';
import me from '../src/handlers/users/me.js';
import updateProfile from '../src/handlers/users/update-profile.js';
import updateWorkspace from '../src/handlers/workspace/update.js';

const ADA = '01930000-0000-7000-8000-00000000ada1';
const SESSION = '01930000-0000-7000-8000-0000000005e1';
const OTHER_SESSION = '01930000-0000-7000-8000-0000000005e2';
const FILE = '01930000-0000-7000-8000-0000000000f1';
const LOGO = '01930000-0000-7000-8000-0000000000f2';
const NOW = new Date('2026-11-12T10:00:00Z');
const OLD_PASSWORD = 'an old enough passphrase';
const DIALECT = new PgDialect({ casing: 'snake_case' });

const USER = {
  id: ADA,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  displayName: 'ada',
  avatarFileId: null as string | null,
  timezone: 'UTC',
  role: 'admin' as const,
  active: true,
  syncGroups: ['workspace'],
  createdAt: NOW,
  updatedAt: NOW,
};

const WORKSPACE = {
  id: '01930000-0000-7000-8000-0000000000aa',
  name: 'Acme',
  logoFileId: null as string | null,
  syncGroups: ['workspace'],
  createdAt: NOW,
  updatedAt: NOW,
};

interface FakeOptions {
  sessionId?: string | undefined;
  user?: Partial<typeof USER>;
  workspace?: Partial<typeof WORKSPACE>;
  otherDisplayNames?: string[];
  passwordHash?: string;
  sessionRows?: object[];
  refs?: Record<string, unknown>;
  ended?: number;
  updateFails?: Error;
  system?: boolean;
  /** Seconds the account's sign-in lockout has left (AC-6). */
  lockedFor?: number;
}

function fakeCtx(options: FakeOptions = {}) {
  const steps: string[] = [];
  const updates: { model: string; id: string; changes: object }[] = [];
  const closed: { userId: string; which: SessionSelection }[] = [];
  const events: DomainEvent[] = [];
  let user = { ...USER, ...options.user };
  let space = { ...WORKSPACE, ...options.workspace };
  let passwordHash = options.passwordHash;
  const rowsOf = (table: unknown): unknown[] => {
    if (table === users) {
      steps.push('read users');
      return (options.otherDisplayNames ?? []).map((displayName) => ({ displayName, id: ADA }));
    }
    if (table === workspace) return [{ id: space.id }];
    if (table === userCredentials) {
      steps.push('read credentials');
      return passwordHash === undefined ? [] : [{ passwordHash }];
    }
    if (table === sessions) return options.sessionRows ?? [];
    throw new Error('unexpected table');
  };
  // Each filter as the SQL it renders to, so a test can check that a query is scoped to the
  // actor: the fake returns its rows whatever the filter (S6 review).
  const filters: { table: string; text: string; params: unknown[] }[] = [];
  const chain = (table: string, rows: () => unknown[]) => {
    const builder = {
      where: (condition: SQL) => {
        const { sql: text, params } = DIALECT.sqlToQuery(condition);
        filters.push({ table, text, params });
        return builder;
      },
      limit: () => builder,
      orderBy: () => builder,
      for: (strength: string) => {
        steps.push(`lock ${strength}`);
        return builder;
      },
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
    };
    return builder;
  };
  const tx = {
    select: () => ({
      from: (table: PgTable) => chain(`select ${getTableName(table)}`, () => rowsOf(table)),
    }),
    update: (table: unknown) => ({
      set: (patch: { passwordHash: string }) => {
        if (table !== userCredentials) throw new Error('unexpected update');
        steps.push('write password');
        passwordHash = patch.passwordHash;
        return chain('update user_credentials', () => []);
      },
    }),
  };
  const audits: { event: string; fields: object; message: string }[] = [];
  const reserved: string[][] = [];
  const cleared: string[] = [];
  const attempts: AttemptStore = {
    reserve: (keys) => {
      steps.push('reserve attempt');
      reserved.push([...keys]);
      return Promise.resolve(
        options.lockedFor === undefined
          ? { ok: true, attempt: [7] }
          : { ok: false, lockedForSeconds: options.lockedFor },
      );
    },
    succeeded: (attempt, clearKey) => {
      steps.push('clear attempts');
      expect(attempt).toEqual([7]);
      cleared.push(clearKey);
      return Promise.resolve();
    },
  };
  const ctx = {
    attempts,
    actor: options.system
      ? { kind: 'system', groups: [] }
      : userActor({
          userId: ADA,
          role: 'admin',
          memberships: [],
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        }),
    refs: options.refs ?? {},
    tx,
    now: () => NOW,
    query: {
      get: (model: string) => {
        steps.push(`get ${model}`);
        return Promise.resolve(model === 'User' ? user : space);
      },
    },
    repo: {
      update: (model: string, id: string, changes: object) => {
        if (options.updateFails !== undefined) return Promise.reject(options.updateFails);
        updates.push({ model, id, changes });
        if (model === 'User') user = { ...user, ...changes };
        else space = { ...space, ...changes };
        return Promise.resolve(model === 'User' ? user : space);
      },
    },
    closeSessions: (userId: string, which: SessionSelection) => {
      steps.push('close sessions');
      closed.push({ userId, which });
      return Promise.resolve(options.ended ?? 1);
    },
    emit: (event: DomainEvent) => void events.push(event),
    audit: (event: string, fields: object, message: string) =>
      void audits.push({ event, fields, message }),
  } as unknown as HandlerContext;
  return {
    ctx,
    steps,
    updates,
    closed,
    events,
    filters,
    audits,
    reserved,
    cleared,
    passwordHash: () => passwordHash,
  };
}

describe('user.me (SPEC-001 §6.2)', () => {
  it('returns the signed-in user', async () => {
    const { ctx } = fakeCtx();
    expect(await me.run(ctx, {})).toMatchObject({ id: ADA, displayName: 'ada', role: 'admin' });
  });

  it('is FORBIDDEN for an actor without an account (the system actor)', async () => {
    const { ctx } = fakeCtx({ system: true });
    await expect(me.run(ctx, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('user.updateProfile (SPEC-001 §3.5, AC-15)', () => {
  it('writes only the changed fields to the synced user row, trimmed and canonical', async () => {
    const { ctx, updates, steps } = fakeCtx();
    const result = await updateProfile.run(ctx, {
      name: '  Ada King ',
      displayName: 'ada',
      timezone: 'europe/berlin',
    });
    expect(updates).toEqual([
      { model: 'User', id: ADA, changes: { name: 'Ada King', timezone: 'Europe/Berlin' } },
    ]);
    expect(result).toMatchObject({ name: 'Ada King', timezone: 'Europe/Berlin' });
    // The row is locked before it is read: two saves at once run one after the other.
    expect(steps.slice(0, 3)).toEqual(['lock no key update', 'read users', 'get User']);
  });

  it('writes nothing when nothing changes', async () => {
    const { ctx, updates } = fakeCtx();
    await updateProfile.run(ctx, { name: 'Ada Lovelace', timezone: 'UTC', avatar: null });
    expect(updates).toEqual([]);
  });

  it('refuses a display name someone else has, without case, suggesting a free one (E5)', async () => {
    const { ctx, updates } = fakeCtx({ otherDisplayNames: ['Grace', 'grace2'] });
    await expect(updateProfile.run(ctx, { displayName: 'grace' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('grace3') as unknown,
      details: { issues: [{ path: ['displayName'] }] },
    });
    expect(updates).toEqual([]);
  });

  it('lets you change the case of your own display name', async () => {
    const { ctx, updates, steps } = fakeCtx();
    await updateProfile.run(ctx, { displayName: 'Ada' });
    expect(updates).toEqual([{ model: 'User', id: ADA, changes: { displayName: 'Ada' } }]);
    // Only the lock reads users: no lookup of other names.
    expect(steps.filter((step) => step === 'read users')).toHaveLength(1);
  });

  it('turns a display name taken between the check and the write into CONFLICT', async () => {
    const race = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'users_display_name_idx',
    });
    const { ctx } = fakeCtx({ updateFails: race });
    await expect(updateProfile.run(ctx, { displayName: 'grace' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'That display name was just taken. Try another one.',
    });
  });

  it('sets the avatar to a file the executor resolved, and removes it with null', async () => {
    const set = fakeCtx({ refs: { avatar: { id: FILE, purpose: 'avatar' } } });
    await updateProfile.run(set.ctx, { avatar: FILE });
    expect(set.updates).toEqual([{ model: 'User', id: ADA, changes: { avatarFileId: FILE } }]);

    const removed = fakeCtx({ user: { avatarFileId: FILE } });
    await updateProfile.run(removed.ctx, { avatar: null });
    expect(removed.updates).toEqual([{ model: 'User', id: ADA, changes: { avatarFileId: null } }]);
  });

  it('refuses a file uploaded as a logo as the avatar', async () => {
    const { ctx, updates } = fakeCtx({ refs: { avatar: { id: LOGO, purpose: 'logo' } } });
    await expect(updateProfile.run(ctx, { avatar: LOGO })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: [{ path: ['avatar'] }] },
    });
    expect(updates).toEqual([]);
  });

  it('checks each field with the domain rules before anything runs', () => {
    const parse = (input: object) =>
      updateProfileOp.input.safeParse(input).error?.issues.map((issue) => issue.message);
    expect(parse({ name: '  ' })).toEqual(['Name is required']);
    expect(parse({ displayName: 'ada lovelace' })?.[0]).toMatch(/^Display name can use letters/);
    expect(parse({ timezone: 'Mars/Olympus' })?.[0]).toMatch(/is not a time zone/);
    expect(parse({ avatar: 'avatar.png' })).toEqual(['Use a file id from POST /files/upload']);
  });
});

describe('user.changePassword (SPEC-001 §3.5, E10)', () => {
  it('checks the current password, sets the new one and ends the other sessions', async () => {
    const { ctx, steps, closed, audits, passwordHash } = fakeCtx({
      sessionId: SESSION,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    const result = await changePassword.run(ctx, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(result).toEqual({ endedSessions: 1 });
    expect(await verifyPassword(passwordHash() ?? '', 'a brand new passphrase')).toBe(true);
    // This session stays; the others' sockets close once the operation commits (AC-8).
    expect(closed).toEqual([{ userId: ADA, which: { except: SESSION } }]);
    // SPEC-001 §10: an audit line with ids only, never a password.
    expect(audits).toEqual([
      { event: 'auth.password_changed', fields: { userId: ADA }, message: 'password changed' },
    ]);
    expect(steps).toEqual([
      'get User',
      'reserve attempt',
      'lock update',
      'read credentials',
      'clear attempts',
      'write password',
      'close sessions',
    ]);
  });

  it('reads and writes only your own credentials', async () => {
    const { ctx, filters } = fakeCtx({
      sessionId: SESSION,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await changePassword.run(ctx, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    const credentials = filters.filter((f) => f.table.endsWith('user_credentials'));
    expect(credentials.map((f) => f.table)).toEqual([
      'select user_credentials',
      'update user_credentials',
    ]);
    for (const filter of credentials) {
      expect(filter.text).toBe('"user_credentials"."user_id" = $1');
      expect(filter.params).toEqual([ADA]);
    }
  });

  it('counts a wrong current password as a failed sign-in of the account (AC-6)', async () => {
    const { ctx, reserved, cleared } = fakeCtx({
      sessionId: SESSION,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await expect(
      changePassword.run(ctx, { currentPassword: 'not it at all', newPassword: 'a brand new one' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Reserved before the check and never cleared, so it stays a failure after the rollback.
    expect(reserved).toEqual([['account:ada@example.com']]);
    expect(cleared).toEqual([]);
  });

  it('clears the account’s failures once the current password is right', async () => {
    const { ctx, cleared } = fakeCtx({
      sessionId: SESSION,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await changePassword.run(ctx, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(cleared).toEqual(['account:ada@example.com']);
  });

  it('refuses while the account is locked, without checking the password', async () => {
    const { ctx, steps, passwordHash } = fakeCtx({
      sessionId: SESSION,
      passwordHash: await hashPassword(OLD_PASSWORD),
      lockedFor: 540,
    });
    const hash = passwordHash();
    await expect(
      changePassword.run(ctx, { currentPassword: OLD_PASSWORD, newPassword: 'a brand new one' }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many wrong passwords. Try again in 9 minutes.',
      details: { retryAfter: 540 },
    });
    expect(steps).toEqual(['get User', 'reserve attempt']);
    expect(passwordHash()).toBe(hash);
  });

  it('refuses a wrong current password on its field, changing nothing', async () => {
    const hash = await hashPassword(OLD_PASSWORD);
    const { ctx, steps, closed, passwordHash } = fakeCtx({
      sessionId: SESSION,
      passwordHash: hash,
    });
    await expect(
      changePassword.run(ctx, { currentPassword: 'not it at all', newPassword: 'a brand new one' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: WRONG_CURRENT_PASSWORD,
      details: { issues: [{ path: ['currentPassword'] }] },
    });
    expect(passwordHash()).toBe(hash);
    expect(closed).toEqual([]);
    expect(steps).not.toContain('write password');
  });

  it('ends every session for an actor without one of its own', async () => {
    const { ctx, closed } = fakeCtx({ passwordHash: await hashPassword(OLD_PASSWORD) });
    await changePassword.run(ctx, {
      currentPassword: OLD_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(closed).toEqual([{ userId: ADA, which: { all: true } }]);
  });

  it('refuses a new password that breaks AC-9 before anything runs', () => {
    const parsed = changePasswordOp.input.safeParse({ currentPassword: 'x', newPassword: 'short' });
    expect(parsed.error?.issues[0]?.path).toEqual(['newPassword']);
  });
});

describe('session.list, session.revoke, session.revokeOthers (SPEC-001 §3.5, AC-8)', () => {
  const row = (id: string, lastUsedAt: string) => ({
    id,
    userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0',
    ip: '192.0.2.1',
    createdAt: NOW,
    lastUsedAt: new Date(lastUsedAt),
  });

  it('lists only your own sessions that haven’t expired', async () => {
    const { ctx, filters } = fakeCtx({ sessionId: SESSION });
    await listSessions.run(ctx, { limit: 50, includeArchived: false });
    expect(filters).toEqual([
      {
        table: 'select sessions',
        text: '("sessions"."user_id" = $1 and "sessions"."expires_at" > $2)',
        params: [ADA, NOW.toISOString()],
      },
    ]);
  });

  it('lists your sessions, most recent first, with this one marked', async () => {
    const { ctx } = fakeCtx({
      sessionId: SESSION,
      sessionRows: [
        row(SESSION, '2026-11-12T09:00:00Z'),
        row(OTHER_SESSION, '2026-11-12T09:30:00Z'),
      ],
    });
    const result = sessionListOp.output.parse(
      await listSessions.run(ctx, { limit: 50, includeArchived: false }),
    );
    expect(result.nodes.map((s) => [s.id, s.current])).toEqual([
      [OTHER_SESSION, false],
      [SESSION, true],
    ]);
    const others = sessionListOp.output.parse(
      await listSessions.run(ctx, {
        limit: 50,
        includeArchived: false,
        filter: { field: 'current', op: 'eq', value: false },
      }),
    );
    expect(others.nodes.map((s) => s.id)).toEqual([OTHER_SESSION]);
  });

  it('revoke ends exactly the session the executor resolved', async () => {
    const { ctx, closed } = fakeCtx({
      sessionId: SESSION,
      refs: { session: { id: OTHER_SESSION } },
    });
    expect(await revokeSession.run(ctx, { session: OTHER_SESSION })).toEqual({ revoked: true });
    expect(closed).toEqual([{ userId: ADA, which: { only: OTHER_SESSION } }]);
  });

  it('revoke says so when the session had already ended', async () => {
    const { ctx } = fakeCtx({ ended: 0, refs: { session: { id: OTHER_SESSION } } });
    expect(await revokeSession.run(ctx, { session: OTHER_SESSION })).toEqual({ revoked: false });
  });

  it('revokeOthers keeps this session', async () => {
    const { ctx, closed } = fakeCtx({ sessionId: SESSION, ended: 3 });
    expect(await revokeOthers.run(ctx, {})).toEqual({ revoked: 3 });
    expect(closed).toEqual([{ userId: ADA, which: { except: SESSION } }]);
  });
});

describe('workspace.update with a logo (SPEC-001 §3.6; PLAN-001 S6)', () => {
  it('sets the logo to an uploaded logo file and emits the change', async () => {
    const { ctx, updates, events } = fakeCtx({ refs: { logo: { id: LOGO, purpose: 'logo' } } });
    const result = workspaceUpdateOp.output.parse(await updateWorkspace.run(ctx, { logo: LOGO }));
    expect(result.logoFileId).toBe(LOGO);
    expect(updates).toEqual([
      { model: 'Workspace', id: WORKSPACE.id, changes: { logoFileId: LOGO } },
    ]);
    expect(events).toEqual([
      {
        type: 'workspace.updated',
        subject: { type: 'workspace', id: WORKSPACE.id },
        changes: { logoFileId: { from: null, to: LOGO } },
      },
    ]);
  });

  it('removes the logo with null, and writes nothing when nothing changes', async () => {
    const removed = fakeCtx({ workspace: { logoFileId: LOGO } });
    await updateWorkspace.run(removed.ctx, { logo: null });
    expect(removed.updates).toEqual([
      { model: 'Workspace', id: WORKSPACE.id, changes: { logoFileId: null } },
    ]);
    const same = fakeCtx({
      refs: { logo: { id: LOGO, purpose: 'logo' } },
      workspace: { logoFileId: LOGO },
    });
    await updateWorkspace.run(same.ctx, { name: 'Acme', logo: LOGO });
    expect(same.updates).toEqual([]);
    expect(same.events).toEqual([]);
  });

  it('refuses an avatar file as the logo', async () => {
    const { ctx, updates } = fakeCtx({ refs: { logo: { id: FILE, purpose: 'avatar' } } });
    await expect(updateWorkspace.run(ctx, { logo: FILE })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: [{ path: ['logo'] }] },
    });
    expect(updates).toEqual([]);
  });
});

describe('SessionRef and FileRef (SPEC-003 §4; PLAN-001 S6)', () => {
  function db(rows: object[]) {
    const calls: [string, unknown[]][] = [];
    return {
      calls,
      query: (text: string, params: unknown[]) => {
        calls.push([text.replace(/\s+/g, ' '), params]);
        return Promise.resolve({ rows });
      },
    };
  }
  const actor = { kind: 'user' as const, userId: ADA, groups: ['workspace'] };
  const at = (found: ReturnType<typeof db>, path: string, who = actor) => ({
    db: found as never,
    actor: who,
    path: [path],
    allowInactive: false,
  });

  it('resolves only your own live session, by id', async () => {
    const found = db([{ id: OTHER_SESSION, userId: ADA }]);
    await expect(
      lookup('SessionRef', OTHER_SESSION.toUpperCase(), at(found, 'session')),
    ).resolves.toEqual({
      id: OTHER_SESSION,
      userId: ADA,
    });
    expect(found.calls[0]?.[0]).toMatch(
      /WHERE id = \$1 AND user_id = \$2 AND expires_at > now\(\)/,
    );
    expect(found.calls[0]?.[1]).toEqual([OTHER_SESSION, ADA]);
  });

  it('is NOT_FOUND for anyone else’s session, and for an actor without a user, without a query', async () => {
    await expect(lookup('SessionRef', SESSION, at(db([]), 'session'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `Session "${SESSION}" not found. Use a session id from session.list.`,
    });
    const none = db([{ id: SESSION }]);
    await expect(
      lookup('SessionRef', SESSION, at(none, 'session', { kind: 'system', groups: [] } as never)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(none.calls).toEqual([]);
  });

  it('resolves a file you uploaded or the one in use, never someone else’s unused upload', async () => {
    const found = db([{ id: FILE, purpose: 'avatar' }]);
    await expect(lookup('FileRef', FILE, at(found, 'avatar'))).resolves.toEqual({
      id: FILE,
      purpose: 'avatar',
    });
    expect(found.calls[0]?.[0]).toMatch(
      /uploader_id = \$2 OR id = \(SELECT avatar_file_id FROM users WHERE id = \$2\) OR id = \(SELECT logo_file_id FROM workspace LIMIT 1\)/,
    );
    await expect(lookup('FileRef', FILE, at(db([]), 'avatar'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `File "${FILE}" not found. Upload the image with POST /files/upload and use the id it returns.`,
    });
  });

  it('are workspace-wide, so an API key’s team limit doesn’t narrow them', () => {
    expect(teamIdOf('SessionRef', { id: SESSION })).toBeNull();
    expect(teamIdOf('FileRef', { id: FILE })).toBeNull();
  });
});
