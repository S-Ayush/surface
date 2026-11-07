// SPEC-001 AC-6, E13 (policy part): 5 failures in 15 minutes lock a key until the oldest of them
// leaves the window; IPv6 clients count by their /64; the Postgres store takes per-key locks so
// guesses sent at once can't all pass. The routes' use of it is in auth-routes.test.ts.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ipKey,
  LOCKOUT,
  lockedForSeconds,
  longestLock,
  pgAttemptStore,
} from '../src/auth/attempts.js';

const T0 = Date.parse('2026-11-07T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe('lockedForSeconds', () => {
  it('allows four failures, and locks on the fifth', () => {
    const four = [0, 1, 2, 3].map(at);
    expect(lockedForSeconds(four, at(4))).toBeUndefined();
    expect(lockedForSeconds([...four, at(4)], at(4))).toBe(11 * 60); // until minute 0 + 15
  });

  it('unlocks when the oldest failure of the five leaves the 15-minute window', () => {
    const five = [0, 1, 2, 3, 4].map(at);
    expect(lockedForSeconds(five, at(10))).toBe(5 * 60);
    expect(lockedForSeconds(five, at(14.99))).toBe(1);
    expect(lockedForSeconds(five, at(15))).toBeUndefined();
  });

  it('counts only the failures inside the window, in any order', () => {
    const failures = [at(13), at(0), at(12), at(11), at(14), at(-30)];
    // Five within the window at minute 14: 0, 11, 12, 13, 14.
    expect(lockedForSeconds(failures, at(14))).toBe(LOCKOUT.windowMs / 1000 - 14 * 60);
    // At minute 15 the one from minute 0 is gone: four left.
    expect(lockedForSeconds(failures, at(15))).toBeUndefined();
  });

  it('with more than five, waits for the one whose expiry brings the count below five', () => {
    const seven = [0, 1, 2, 3, 4, 5, 6].map(at);
    // The 3rd-oldest (minute 2) leaves at minute 17.
    expect(lockedForSeconds(seven, at(6))).toBe(11 * 60);
  });
});

describe('longestLock', () => {
  it('locks an account after 5 failures and an address only after 20 (Q8)', () => {
    const times = (n: number) => Array.from({ length: n }, (_, i) => at(i / 10));
    const lock = (key: string, n: number) => longestLock(new Map([[key, times(n)]]), [key], at(3));
    expect(lock('account:ada@example.com', 5)).toBeDefined();
    expect(lock('ip:203.0.113.7', 5)).toBeUndefined();
    expect(lock('ip:203.0.113.7', 19)).toBeUndefined();
    expect(lock('ip:203.0.113.7', 20)).toBeDefined();
  });
});

describe('ipKey', () => {
  it('counts an IPv4 address, plain or mapped into IPv6, by the address', () => {
    expect(ipKey('203.0.113.7')).toBe('ip:203.0.113.7');
    expect(ipKey('::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
  });

  it('counts an IPv6 client by its /64, however the address is written', () => {
    const key = 'ip:2001:db8:0:1::/64';
    expect(ipKey('2001:db8:0:1:aaaa:bbbb:cccc:dddd')).toBe(key);
    expect(ipKey('2001:0db8:0000:0001::9')).toBe(key);
    expect(ipKey('2001:db8::1:0:0:0:5')).toBe(key);
    expect(ipKey('2001:db8:0:2::1')).not.toBe(key);
    expect(ipKey('fe80::1%en0')).toBe('ip:fe80:0:0:0::/64');
    expect(ipKey('::1')).toBe('ip:0:0:0:0::/64');
  });
});

/** A pool whose one client answers from a script and records every statement. */
function scriptedPool(recent: { key: string; attempted_at: Date }[]) {
  const statements: { text: string; values: unknown[] }[] = [];
  const listeners = new Set<unknown>();
  let released: boolean | Error | undefined;
  const client = {
    query: (text: string, values: unknown[] = []) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (text.includes('SELECT key, attempted_at')) return Promise.resolve({ rows: recent });
      if (text.includes('INSERT INTO auth_attempts')) {
        return Promise.resolve({ rows: [{ id: '41' }, { id: '42' }] });
      }
      return Promise.resolve({ rows: [] });
    },
    on: (_event: string, fn: unknown) => void listeners.add(fn),
    removeListener: (_event: string, fn: unknown) => void listeners.delete(fn),
    release: (error?: boolean | Error) => {
      released = error ?? false;
    },
  };
  const pool = {
    connect: () => Promise.resolve(client),
    query: (text: string, values: unknown[] = []) => client.query(text, values),
  };
  return {
    pool: pool as unknown as Pick<pg.Pool, 'connect' | 'query'>,
    statements,
    texts: () => statements.map((s) => s.text),
    listeners,
    released: () => released,
  };
}

describe('pgAttemptStore', () => {
  const keys = ['ip:203.0.113.7', 'account:ada@example.com'];

  it('locks each key, in order, before reading, then records the attempt in the same transaction', async () => {
    const db = scriptedPool([]);
    const result = await pgAttemptStore(db.pool).reserve(keys, at(0));
    expect(result).toEqual({ ok: true, attempt: [41, 42] });
    const texts = db.texts();
    expect(texts[0]).toBe('BEGIN');
    // Sorted, so two sign-ins sharing keys take the locks in the same order (no deadlock).
    expect(db.statements.slice(1, 3).map((s) => s.values[1])).toEqual([
      'account:ada@example.com',
      'ip:203.0.113.7',
    ]);
    expect(texts.slice(1, 3).every((t) => t.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(texts[3]).toContain('SELECT key, attempted_at');
    expect(texts[4]).toContain('DELETE FROM auth_attempts WHERE attempted_at <=');
    expect(texts[5]).toContain('INSERT INTO auth_attempts');
    expect(texts[6]).toBe('COMMIT');
    expect([db.released(), db.listeners.size]).toEqual([false, 0]);
  });

  it('records nothing for a locked key and says for how long', async () => {
    const five = [0, 1, 2, 3, 4].map((m) => ({ key: keys[1] ?? '', attempted_at: at(m) }));
    const db = scriptedPool(five);
    const result = await pgAttemptStore(db.pool).reserve(keys, at(5));
    expect(result).toEqual({ ok: false, lockedForSeconds: 10 * 60 });
    expect(db.texts().at(-1)).toBe('ROLLBACK');
    expect(db.texts().some((t) => t.includes('INSERT'))).toBe(false);
  });

  it('forgets the successful attempt and the account’s failures', async () => {
    const db = scriptedPool([]);
    await pgAttemptStore(db.pool).succeeded([41, 42], 'account:ada@example.com');
    expect(db.statements).toEqual([
      {
        text: 'DELETE FROM auth_attempts WHERE id = ANY($1::bigint[]) OR key = $2',
        values: [[41, 42], 'account:ada@example.com'],
      },
    ]);
  });
});
