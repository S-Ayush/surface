// PLAN-001 S3, SPEC-001 AC-7 (storage part) and E14: what the real session code sends to Postgres,
// checked against a recording client (no database; the integration test is held, plans README §6).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createSession, SESSION_TTL_MS } from '../src/auth/session.js';
import { deleteUserSessions, pgAuthStore } from '../src/auth/store.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Records each statement; answers `SELECT`s with `rows`. */
function recordingPool(rows: Record<string, unknown>[] = []) {
  const statements: { text: string; values: unknown[] }[] = [];
  const query = (text: string, values: unknown[] = []) => {
    statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve({ rows: text.trim().startsWith('SELECT') ? rows : [] });
  };
  // Only `query` is used; pg's overloads are more than a recording stand-in can satisfy.
  return { statements, query, pool: { query } as unknown as Pick<pg.Pool, 'query'> };
}

describe('createSession', () => {
  it('stores only the SHA-256 of the token it returns, never the token (AC-7)', async () => {
    const db = recordingPool();
    const session = await createSession(db, {
      userId: 'u1',
      userAgent: 'Firefox',
      ip: '203.0.113.7',
      now: NOW,
    });
    expect(session.token).toMatch(/^[\w-]{43}$/);
    const [insert] = db.statements;
    expect(insert?.values).toContain(sha256(session.token));
    expect(JSON.stringify(db.statements)).not.toContain(session.token);
    expect(session.expiresAt).toEqual(new Date(NOW.getTime() + SESSION_TTL_MS));
  });
});

describe('pgAuthStore', () => {
  it('finds a session by its token hash only while it is unexpired and its user active (E14)', async () => {
    const db = recordingPool([
      {
        id: 's1',
        user_id: 'u1',
        workspace_id: 'w1',
        role: 'member',
        last_used_at: NOW,
        memberships: [{ teamId: 't1', private: true }],
        public_teams: ['t2', 't3'],
      },
    ]);
    const record = await pgAuthStore(db.pool).session('hash', NOW);
    expect(record).toEqual({
      id: 's1',
      userId: 'u1',
      workspaceId: 'w1',
      role: 'member',
      memberships: [{ teamId: 't1', private: true }],
      publicTeams: ['t2', 't3'],
      lastUsedAt: NOW,
    });
    const [select] = db.statements;
    expect(select?.values).toEqual(['hash', NOW]);
    expect(select?.text).toContain('WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active');
  });

  it('answers no session when the query finds none', async () => {
    expect(await pgAuthStore(recordingPool([]).pool).session('hash', NOW)).toBeUndefined();
  });

  it('gives credentials only for an active user', async () => {
    const db = recordingPool([{ user_id: 'u1', password_hash: '$argon2id$x' }]);
    expect(await pgAuthStore(db.pool).credentials('ada@example.com')).toEqual({
      userId: 'u1',
      passwordHash: '$argon2id$x',
    });
    expect(db.statements[0]?.text).toContain('WHERE u.email = $1 AND u.active');
  });

  it('extends a session to 30 days from now, and deletes one by id', async () => {
    const db = recordingPool();
    const store = pgAuthStore(db.pool);
    await store.touch('s1', NOW);
    await store.deleteSession('s1');
    expect(db.statements).toEqual([
      {
        text: 'UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1',
        values: ['s1', NOW, new Date(NOW.getTime() + SESSION_TTL_MS)],
      },
      { text: 'DELETE FROM sessions WHERE id = $1', values: ['s1'] },
    ]);
  });
});

describe('deleteUserSessions', () => {
  /** Answers the `DELETE … RETURNING id` with the ids it is given. */
  function deletingClient(ids: string[]) {
    const statements: { text: string; values: unknown[] }[] = [];
    const query = (text: string, values: unknown[] = []) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve({ rows: ids.map((id) => ({ id })) });
    };
    return { statements, client: { query } as unknown as Pick<pg.PoolClient, 'query'> };
  }

  it('ends only the user’s own sessions: all, all but one, or one, and says which', async () => {
    const all = deletingClient(['s1', 's2']);
    expect(await deleteUserSessions(all.client, 'u1', { all: true })).toEqual(['s1', 's2']);
    const others = deletingClient(['s2']);
    await deleteUserSessions(others.client, 'u1', { except: 's1' });
    const one = deletingClient(['s2']);
    await deleteUserSessions(one.client, 'u1', { only: 's2' });

    for (const { statements } of [all, others, one]) {
      expect(statements).toHaveLength(1);
      expect(statements[0]?.text).toMatch(
        /^DELETE FROM sessions WHERE user_id = \$1 .* RETURNING id$/,
      );
    }
    // $1 the user, $2 the one session to end, $3 the session to keep.
    expect(all.statements[0]?.values).toEqual(['u1', null, null]);
    expect(others.statements[0]?.values).toEqual(['u1', null, 's1']);
    expect(one.statements[0]?.values).toEqual(['u1', 's2', null]);
  });
});
