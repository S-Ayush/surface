/**
 * Exactly-once (SPEC-002 AC-3) across crashes and resends, with bursts,
 * against the real server (PLAN-002 S9 part 2, ADR-0016), one fresh database per case; split
 * from `real-server.int.test.ts` so the properties run in parallel.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { exactlyOnce } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { exactlyOnceCase } from '../src/steps.js';
import { realServers } from './support/real-servers.js';

describe('against the real server', () => {
  it('applies every saved mutation exactly once across crashes and resends (AC-3)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(exactlyOnceCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...exactlyOnce.options, server }, exactlyOnce.check),
      ),
      simParameters(),
    );
  });
});
