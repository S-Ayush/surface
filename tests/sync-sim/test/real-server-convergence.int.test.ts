/**
 * Convergence (SPEC-002 AC-2), with bursts past the rate limit,
 * against the real server (PLAN-002 S9 part 2, ADR-0016), one fresh database per case; split
 * from `real-server.int.test.ts` so the properties run in parallel.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { convergence } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { convergenceCase } from '../src/steps.js';
import { realServers } from './support/real-servers.js';

describe('against the real server', () => {
  it('every tab converges on the server state after any faults (AC-2)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(convergenceCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...convergence.options, server }, convergence.check),
      ),
      simParameters(),
    );
  });
});
