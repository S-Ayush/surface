// In-memory stand-ins for the sign-in stores (PLAN-001 S3), shared by the auth tests.
import { createHash, randomBytes } from 'node:crypto';
import type { Membership } from '@surface/domain';
import { LOCKOUT, longestLock, type AttemptStore, type Reservation } from '../src/auth/attempts.js';
import { SESSION_TTL_MS, type NewSession } from '../src/auth/session.js';
import type { AuthStore, SessionRecord } from '../src/auth/store.js';

export const WORKSPACE = 'ws-00000-0000-0000-000000000001';

/** A `SessionRecord` the fake can update in place, plus the columns it is looked up by. */
export type StoredSession = { -readonly [K in keyof SessionRecord]: SessionRecord[K] } & {
  tokenHash: string;
  expiresAt: Date;
};

/** Sessions keyed by token hash, like the table: the token itself is never seen here. */
export class FakeAuthStore implements AuthStore {
  readonly users = new Map<string, { userId: string; passwordHash: string }>();
  readonly sessions = new Map<string, StoredSession>();
  readonly memberships = new Map<string, Membership[]>();
  readonly touches: string[] = [];
  readonly inserted: Record<string, unknown>[] = [];

  credentials = (email: string) => Promise.resolve(this.users.get(email));

  createSession = (session: NewSession) => {
    const token = randomBytes(32).toString('base64url');
    const id = `session-${this.inserted.length + 1}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(session.now.getTime() + SESSION_TTL_MS);
    this.inserted.push({ id, userId: session.userId, tokenHash, expiresAt });
    this.sessions.set(tokenHash, {
      id,
      userId: session.userId,
      workspaceId: WORKSPACE,
      role: 'admin',
      memberships: [],
      lastUsedAt: session.now,
      tokenHash,
      expiresAt,
    });
    return Promise.resolve({ id, token, expiresAt });
  };

  session = (tokenHash: string, now: Date): Promise<SessionRecord | undefined> => {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt <= now) return Promise.resolve(undefined);
    return Promise.resolve({ ...s, memberships: this.memberships.get(s.userId) ?? [] });
  };

  touch = (sessionId: string, now: Date) => {
    this.touches.push(sessionId);
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        s.lastUsedAt = now;
        s.expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      }
    }
    return Promise.resolve();
  };

  deleteSession = (sessionId: string) => {
    for (const [hash, s] of this.sessions) if (s.id === sessionId) this.sessions.delete(hash);
    return Promise.resolve();
  };
}

/**
 * `auth_attempts` in memory, with the same semantics as the Postgres store. `reserve` reads and
 * writes in one synchronous step, as the per-key lock makes it in Postgres.
 */
export class FakeAttempts implements AttemptStore {
  rows: { id: number; key: string; at: Date }[] = [];
  #nextId = 1;
  reserve = (keys: readonly string[], now: Date): Promise<Reservation> => {
    const since = now.getTime() - LOCKOUT.windowMs;
    const byKey = new Map<string, Date[]>();
    for (const r of this.rows) {
      if (keys.includes(r.key) && r.at.getTime() > since) {
        byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.at]);
      }
    }
    const locked = longestLock(byKey, keys, now);
    if (locked !== undefined) return Promise.resolve({ ok: false, lockedForSeconds: locked });
    this.rows = this.rows.filter((r) => r.at.getTime() > since);
    const attempt = keys.map((key) => {
      const id = this.#nextId++;
      this.rows.push({ id, key, at: now });
      return id;
    });
    return Promise.resolve({ ok: true, attempt });
  };
  succeeded = (attempt: readonly number[], clearKey: string) => {
    this.rows = this.rows.filter((r) => !attempt.includes(r.id) && r.key !== clearKey);
    return Promise.resolve();
  };
}
