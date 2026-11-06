// SPEC-003 §9: per-actor limits, queries 600/min and mutations 120/min; session users are
// exempt from the query limit; the system actor is never limited.
import { randomUUID } from 'node:crypto';
import type { ApiKeyScope } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { tokenBucket } from '../src/executor/rate-limit.js';
import { actorFor, systemActor } from './helpers.js';

const key = (): ApiKeyScope => ({
  id: randomUUID(),
  scope: 'read_write',
  teamIds: [],
  allowDestructive: false,
});
const user = { id: randomUUID() };

function clock() {
  let now = 1_700_000_000_000;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** How many of `n` calls were allowed. */
function takeMany(n: number, take: () => { allowed: boolean }): number {
  return Array.from({ length: n }, take).filter((d) => d.allowed).length;
}

describe('tokenBucket', () => {
  it('allows a minute’s mutations in a burst, then says when to retry', () => {
    const time = clock();
    const limiter = tokenBucket({ queriesPerMinute: 600, mutationsPerMinute: 120 }, time.now);
    const actor = actorFor(user);
    const allowed = takeMany(121, () => limiter.take(actor, 'mutation'));
    expect(allowed).toBe(120);
    // One token refills every 0.5 s.
    expect(limiter.take(actor, 'mutation')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(500);
    expect(limiter.take(actor, 'mutation')).toEqual({ allowed: true });
    expect(limiter.take(actor, 'mutation').allowed).toBe(false);
  });

  it('limits API and MCP queries, but not session users’ queries', () => {
    const time = clock();
    const limiter = tokenBucket({ queriesPerMinute: 3, mutationsPerMinute: 1 }, time.now);
    const session = actorFor(user);
    const api = actorFor(user, { kind: 'api', apiKey: key() });
    expect(takeMany(50, () => limiter.take(session, 'query'))).toBe(50);
    expect(takeMany(5, () => limiter.take(api, 'query'))).toBe(3);
    expect(limiter.take(api, 'query')).toEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it('keeps separate buckets per key, per kind, and never limits the system actor', () => {
    const time = clock();
    const limiter = tokenBucket({ queriesPerMinute: 1, mutationsPerMinute: 1 }, time.now);
    const a = actorFor(user, { kind: 'api', apiKey: key() });
    const b = actorFor(user, { kind: 'mcp', apiKey: key() });
    expect(limiter.take(a, 'mutation').allowed).toBe(true);
    expect(limiter.take(a, 'mutation').allowed).toBe(false);
    expect(limiter.take(a, 'query').allowed).toBe(true);
    expect(limiter.take(b, 'mutation').allowed).toBe(true);
    expect(takeMany(20, () => limiter.take(systemActor(), 'mutation'))).toBe(20);
  });

  it('refills fully after an idle minute', () => {
    const time = clock();
    const limiter = tokenBucket({ queriesPerMinute: 600, mutationsPerMinute: 2 }, time.now);
    const actor = actorFor(user);
    expect(takeMany(3, () => limiter.take(actor, 'mutation'))).toBe(2);
    time.advance(60_000);
    expect(takeMany(3, () => limiter.take(actor, 'mutation'))).toBe(2);
  });
});
