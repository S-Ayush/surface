/**
 * The overlay with 1,000 pending mutations (a long offline session). A new
 * dispatch must still show in the same frame (SPEC-002 AC-5, < 16 ms), and a
 * full rebuild (a confirm, or a delta to a row the mutations use) must stay
 * well inside a frame too. What they compute is checked in the gate
 * (`overlay-scale.test.ts`); these wall-clock budgets run in `pnpm test:deep`
 * (plans README §6), since a loaded machine can miss them.
 *
 * Node, not a browser: a guard against regressions (an accidental O(n²)),
 * not the real measurement, which is in the nightly perf suite (PLAN-002 S10).
 */
import { expect, it } from 'vitest';
import { PENDING, bestOfFive, debugScene, ISSUES, issueScene } from './support/overlay-scale.js';

const FRAME_MS = 16;

it(`pushes onto and rebuilds ${PENDING} pending mutations within a frame`, () => {
  const { engine, mutations, next } = debugScene();
  const rebuild = bestOfFive(() => engine.rebuild(mutations));
  const push = bestOfFive(
    () => engine.push(next),
    () => engine.rebuild(mutations),
  );

  expect(rebuild, `rebuild took ${rebuild.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
  expect(push, `push took ${push.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
});

// PLAN-011 S8 hardening: one more edit with a replica's worth of issues in the base.
it(`pushes one more of ${PENDING} pending issue edits within a frame, with ${ISSUES} issues in the base`, () => {
  const { engine, mutations, next } = issueScene();
  // AC-5: a new edit shows in the same frame.
  const push = bestOfFive(
    () => engine.push(next),
    () => engine.rebuild(mutations),
  );
  expect(push, `push took ${push.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
});
