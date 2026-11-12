/**
 * Archive interleavings (PLAN-011 S2; SPEC-011 AC-18, debug half; sync-protocol §10 item 8):
 * 3–6 tabs of 3–4 users archive, unarchive, create, rename, touch and delete colliding items
 * while the network delays, drops and disconnects, the server restarts and tabs crash or reload.
 * Once everything settles, every tab (streamed, warm-started, or catching up after a drop or a
 * compaction) equals a fresh bootstrap of the server's state, `archivedAt` and `$archived`
 * included. `A` and `V` carry the full row (protocol v0.7), interleaved with the `U`s of edits and
 * the `D`s of deletes, and with optimistic archives in the overlay.
 *
 * Debug items never leave a replica except by delete, so this generator never sends a `V` for a
 * row the tab doesn't hold; `pool.test.ts`, `live.test.ts` and `storage.contract.test.ts` cover
 * that case. PLAN-011 S4b/S4c: add the Issue's archive-as-removal and restore's `V` (which
 * re-inserts it) to the generator.
 */
import fc from 'fast-check';
import { it } from 'vitest';
import { simParameters } from '../src/context.js';
import { archiveConvergence } from '../src/properties.js';
import { simulate } from '../src/simulate.js';
import { archiveCase } from '../src/steps.js';

it('archive, unarchive, edits and deletes in any interleaving equal a fresh bootstrap (AC-18)', async () => {
  await fc.assert(
    fc.asyncProperty(archiveCase(), (simCase) =>
      simulate(simCase, archiveConvergence.options, archiveConvergence.check),
    ),
    simParameters(),
  );
});
