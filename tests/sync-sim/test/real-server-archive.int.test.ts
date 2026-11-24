/**
 * Archive, unarchive, edits and deletes (SPEC-011 AC-18, PLAN-011 S2) through the real delta writer,
 * against the real server (PLAN-002 S9 part 2, ADR-0016), one fresh database per case; split
 * from `real-server.int.test.ts` so the properties run in parallel.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { archiveConvergence } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { archiveCase } from '../src/steps.js';
import { realServers } from './support/real-servers.js';

describe('against the real server', () => {
  // PLAN-011 S2 (SPEC-011 AC-18): the repo's A and V rows, through the real delta writer.
  it('archive, unarchive, edits and deletes in any interleaving equal a fresh bootstrap (AC-18)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(archiveCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...archiveConvergence.options, server }, archiveConvergence.check),
      ),
      simParameters(),
    );
  });
});
