// `@surface/server/testing` checks its options before it touches the database.
import { describe, expect, it } from 'vitest';
import { startTestServer } from './support/testing.js';

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
