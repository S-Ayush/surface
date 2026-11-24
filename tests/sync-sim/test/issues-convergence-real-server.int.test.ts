/**
 * PLAN-011 S4 and S8, the generated issue runs of the sync property suite (not held, plans README
 * §6) against the real server: SPEC-011 AC-2 (numbers gap-free in commit order, distinct sort
 * keys) and AC-4 (label edits converge, the exclusive rule holds), with bursts, every fault and
 * compaction. Split from `issues-real-server.int.test.ts`, which holds the examples, so the two
 * run in parallel.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { issueConvergence } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { issueCase } from '../src/steps.js';
import { issueServers } from './support/real-servers.js';

describe('issues against the real server', () => {
  it('every tab converges on the issues, and numbering and labels hold, after any faults (AC-2, AC-4)', async () => {
    const { server } = issueServers();
    await fc.assert(
      fc.asyncProperty(issueCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...issueConvergence.options, server }, issueConvergence.check),
      ),
      simParameters(),
    );
  });
});
