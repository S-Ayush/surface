/**
 * The real server for the sync simulation's properties (PLAN-002 S9 part 2): one fresh database
 * per case, cloned from the template the global setup migrated.
 */
import { inject } from 'vitest';
import type { RealServer } from '../../src/real-server.js';
import { startRealServer } from '../../src/real-server.js';
import type { SimServer } from '../../src/server.js';

/** A factory for `simulate` that remembers the last server it started (and only that one). */
export function realServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    return latest;
  };
  return { server, last: () => latest };
}

/** A real server for `simulate`, with the labels and the second team the issue steps name. */
export function issueServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    await latest.seedIssueFixtures();
    return latest;
  };
  return { server, last: () => latest };
}
