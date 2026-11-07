/**
 * Property 2, exactly once (SPEC-002 AC-3, E3, E4): each user's tabs touch
 * that user's own item while requests and responses are lost or hang,
 * abandoned requests arrive late, connections drop, the server restarts, and
 * tabs crash (also between storage writes) or reload, their queues adopted
 * (E5). A touch counts once it was saved to the replica, since a mutation is
 * durable only once stored (SPEC-002 §3.3 step 2, AC-3). A crash before that
 * may lose it. Every saved touch is applied by the
 * server exactly once, and none is rejected.
 */
import fc from 'fast-check';
import { it } from 'vitest';
import { simParameters } from '../src/context.js';
import { exactlyOnce } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { exactlyOnceCase } from '../src/steps.js';

it('applies every saved mutation exactly once across crashes and resends (AC-3)', async () => {
  await fc.assert(
    fc.asyncProperty(exactlyOnceCase(), (simCase) =>
      simulate(simCase, exactlyOnce.options, exactlyOnce.check),
    ),
    simParameters(),
  );
});
