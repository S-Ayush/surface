// PLAN-001 S4: single-use links (state-machines.md "Tokens", SPEC-001 E9), the Admin's
// `user.createResetLink` and `surface reset-password`. The SQL runs against a scripted connection
// here; against Postgres it was checked by hand (new integration tests are held, plans README §6).
import { userActor } from '@surface/domain';
import { evaluatePermission, userCreateResetLink } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { resetPasswordCommand } from '../src/cli/reset-password.js';
import type { HandlerContext } from '../src/executor/context.js';
import createResetLink from '../src/handlers/account/create-reset-link.js';
import { LINK_LIFETIME_TEXT } from '../src/mail/templates.js';
import {
  handlerLinks,
  hashLinkToken,
  issueLink,
  LINK_TTL_MS,
  useLink,
  type LinkDb,
} from '../src/mail/link-tokens.js';
import { testConfig } from './helpers.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const ADA = 'ada-0000-0000-0000-000000000001';

/** A connection that records each statement and answers from `answer`. */
function scriptedDb(answer: (sql: string) => { rows?: unknown[]; rowCount?: number } = () => ({})) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      const { rows = [], rowCount = rows.length } = answer(sql);
      return Promise.resolve({ rows, rowCount });
    },
  } as unknown as LinkDb;
  return { db, statements };
}

const userExists = (sql: string) => (sql.includes('FROM users WHERE id') ? { rowCount: 1 } : {});

describe('link lifetimes', () => {
  it('match what the emails say', () => {
    expect(LINK_TTL_MS.magicLink).toBe(15 * 60 * 1000);
    expect(LINK_LIFETIME_TEXT.magicLink).toBe('15 minutes');
    expect(LINK_TTL_MS.passwordReset).toBe(60 * 60 * 1000);
    expect(LINK_LIFETIME_TEXT.passwordReset).toBe('1 hour');
  });
});

describe('issueLink', () => {
  it('locks the user, turns off earlier links, and stores only the hash (E9)', async () => {
    const { db, statements } = scriptedDb(userExists);
    const link = await issueLink(db, 'magicLink', ADA, { now: NOW });
    expect(link?.expiresAt).toEqual(new Date(NOW.getTime() + LINK_TTL_MS.magicLink));
    expect(statements.map((s) => s.sql.split(' (')[0])).toEqual([
      'SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE',
      'DELETE FROM magic_link_tokens WHERE user_id = $1',
      'INSERT INTO magic_link_tokens',
    ]);
    const insert = statements[2]?.values ?? [];
    expect(insert.slice(1)).toEqual([ADA, hashLinkToken(link?.token ?? ''), NOW, link?.expiresAt]);
    expect(insert).not.toContain(link?.token);
    expect(link?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('issues nothing within the cooldown of an unused link', async () => {
    const { db, statements } = scriptedDb((sql) =>
      sql.includes('FROM users')
        ? { rowCount: 1 }
        : sql.includes('created_at >')
          ? { rowCount: 1 }
          : {},
    );
    expect(await issueLink(db, 'passwordReset', ADA, { now: NOW, cooldownMs: 60_000 })).toBe(
      undefined,
    );
    expect(statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false);
    expect(statements[1]?.values).toEqual([ADA, NOW, new Date(NOW.getTime() - 60_000)]);
  });

  it('issues nothing for a user that does not exist', async () => {
    const { db, statements } = scriptedDb();
    expect(await issueLink(db, 'passwordReset', ADA, { now: NOW })).toBe(undefined);
    expect(statements).toHaveLength(1);
  });
});

describe('useLink', () => {
  it('uses an unused, unexpired link of an active user, by its hash', async () => {
    const { db, statements } = scriptedDb(() => ({ rows: [{ user_id: ADA }] }));
    expect(await useLink(db, 'passwordReset', 'the-token', NOW)).toBe(ADA);
    const [update] = statements;
    expect(update?.sql).toContain('UPDATE password_reset_tokens t SET used_at = $2');
    expect(update?.sql).toContain('t.used_at IS NULL AND t.expires_at > $2');
    expect(update?.sql).toContain('u.active');
    expect(update?.values).toEqual([hashLinkToken('the-token'), NOW]);
  });

  it.each(['', 'x'.repeat(129)])('looks nothing up for a token of length %#', async (token) => {
    const { db, statements } = scriptedDb();
    expect(await useLink(db, 'magicLink', token, NOW)).toBe(undefined);
    expect(statements).toEqual([]);
  });
});

describe('user.createResetLink', () => {
  const ctxWith = (links: HandlerContext['links']) =>
    ({
      refs: { user: { id: ADA } },
      links,
      log: { info: () => undefined },
    }) as unknown as HandlerContext;

  it('returns a reset link on SURFACE_URL, valid 1 hour', async () => {
    const { db } = scriptedDb(userExists);
    const result = await createResetLink.run(
      ctxWith(handlerLinks(db, 'https://surface.example.com', NOW)),
      { user: ADA },
    );
    const parsed = userCreateResetLink.output.parse(result);
    expect(parsed.url).toMatch(/^https:\/\/surface\.example\.com\/reset\?token=[\w-]{43}$/);
    expect(parsed.expiresAt).toBe(
      new Date(NOW.getTime() + LINK_TTL_MS.passwordReset).toISOString(),
    );
  });

  it('is for Admins only (permissions.md §3.1, AC-14)', () => {
    const actor = (role: 'admin' | 'member') => userActor({ userId: ADA, role, memberships: [] });
    const refs = { user: { id: ADA } };
    const input = { user: ADA };
    expect(evaluatePermission(userCreateResetLink, actor('admin'), refs, input).allowed).toBe(true);
    expect(evaluatePermission(userCreateResetLink, actor('member'), refs, input).allowed).toBe(
      false,
    );
  });

  it('fails rather than build a link without SURFACE_URL', async () => {
    const { db } = scriptedDb(userExists);
    await expect(handlerLinks(db, undefined, NOW).passwordReset(ADA)).rejects.toThrow('publicUrl');
  });
});

describe('surface reset-password', () => {
  async function run(email: string, user: { id: string } | undefined) {
    let out = '';
    let err = '';
    const looked: string[] = [];
    const code = await resetPasswordCommand(
      { out: (t) => (out += t), err: (t) => (err += t) },
      testConfig({ publicUrl: 'https://surface.example.com' }),
      email,
      {
        store: {
          withTransaction: (fn) => fn(Object.create(null) as never),
          activeUserByEmail: (_db, address) => {
            looked.push(address);
            return Promise.resolve(user);
          },
          issueLink: (_db, kind, userId) =>
            Promise.resolve(
              kind === 'passwordReset' && userId === ADA
                ? { token: 'the-token', expiresAt: NOW }
                : undefined,
            ),
        },
      },
    );
    return { code, out, err, looked };
  }

  it('prints a reset link for the user, looked up as stored (E2)', async () => {
    const { code, out, err, looked } = await run(' Ada@Example.com', { id: ADA });
    expect([code, err]).toEqual([0, '']);
    expect(looked).toEqual(['ada@example.com']);
    expect(out).toContain('https://surface.example.com/reset?token=the-token');
    expect(out).toContain('It works once, for 1 hour');
  });

  it('says so for an email without an active user, and exits 1', async () => {
    const { code, out, err } = await run('nobody@example.com', undefined);
    expect([code, out]).toEqual([1, '']);
    expect(err).toContain('No active user has the email nobody@example.com.');
  });
});
