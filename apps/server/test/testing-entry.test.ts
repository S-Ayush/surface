// `@surface/server/testing` checks its options before it touches the database.
import { describe, expect, it } from 'vitest';
import { errorLogger, startTestServer } from './support/testing.js';

describe('the real server for the sync simulation, before it starts', () => {
  it('wants a whole number of users, at least 1', async () => {
    // Never connected to: the check comes first.
    const databaseUrl = 'postgres://nobody@127.0.0.1:1/never';
    for (const users of [0, -1, 1.5]) {
      await expect(startTestServer({ databaseUrl, users })).rejects.toThrow(
        `users must be a whole number of at least 1 (got ${users}).`,
      );
    }
  });
});

describe('errorLogger, for a harness that fails on server errors', () => {
  it('reports error and fatal lines with their error message, and nothing below', () => {
    const seen: string[] = [];
    const log = errorLogger((summary) => seen.push(summary));
    log.info('starting');
    log.warn({ userId: 'u1' }, 'sync client too slow to catch up');
    log.error({ err: new Error('connection reset') }, 'sync broadcast failed');
    log.error('no error attached');
    log.fatal({ err: new Error('out of memory') }, 'crashed');
    expect(seen).toEqual([
      'sync broadcast failed: connection reset',
      'no error attached',
      'crashed: out of memory',
    ]);
  });

  it('keeps fields out of the summary, so a secret logged with an error never reaches it', () => {
    const seen: string[] = [];
    errorLogger((summary) => seen.push(summary)).error(
      { password: 'hunter2', err: new Error('login failed') },
      'sign-in failed',
    );
    expect(seen).toEqual(['sign-in failed: login failed']);
    expect(seen.join()).not.toContain('hunter2');
  });
});
