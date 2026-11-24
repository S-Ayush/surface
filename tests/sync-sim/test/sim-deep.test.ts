/**
 * `pnpm sim:deep` (`scripts/sim-deep.mjs`): the runs asked for must reach every property. The
 * real step once gave its runs as the root's `provide`, which each project of
 * `vitest.int.config.js` overrides with its own 20, so a 1,000-case run ran 20.
 */
import { createVitest } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import { CLIENT_SEED, realFiles, stepPlan } from '../scripts/sim-deep-plan.mjs';
import { PROPERTY_SEED } from '../../../packages/sync-client/test/support/fc.js';

describe('pnpm sim:deep', () => {
  it('gives every real-server property the runs asked for, one file at a time', async () => {
    const { options, overrides } = stepPlan('real', 1000);
    const vitest = await createVitest('test', { ...options, run: true, watch: false }, overrides);
    try {
      expect(vitest.projects.length).toBeGreaterThan(0);
      for (const project of vitest.projects) {
        expect(project.getProvidedContext(), project.name).toMatchObject({
          simRuns: 1000,
          propertyRuns: 1000,
          simSeed: 20261107,
          simPath: '',
        });
        // `fileParallelism: false` resolves to one worker.
        expect(project.config.maxWorkers, project.name).toBe(1);
        expect(project.config.testTimeout, project.name).toBeGreaterThanOrEqual(3600_000);
      }
    } finally {
      await vitest.close();
    }
  });

  it.each([
    ['hub', { simRuns: 1000, propertyScale: 1, simSeed: 20261107 }],
    ['client', { propertyRuns: 1000 }],
  ] as const)('gives the %s step’s properties the runs asked for', async (step, provided) => {
    const { options, overrides } = stepPlan(step, 1000);
    const vitest = await createVitest('test', { ...options, run: true, watch: false }, overrides);
    try {
      expect(vitest.projects.length).toBeGreaterThan(0);
      for (const project of vitest.projects) {
        expect(project.getProvidedContext(), project.name).toMatchObject(provided);
        expect(project.config.testTimeout, project.name).toBeGreaterThanOrEqual(3600_000);
      }
    } finally {
      await vitest.close();
    }
  });

  it('runs every real-server file with a generated property, and only those', () => {
    expect(realFiles()).toEqual([
      'test/attachments-real-server.int.test.ts',
      'test/comments-real-server.int.test.ts',
      'test/drafts-real-server.int.test.ts',
      'test/issues-convergence-real-server.int.test.ts',
      'test/issues-real-server.int.test.ts',
      'test/lifecycle-real-server.int.test.ts',
      'test/reactions-real-server.int.test.ts',
      'test/real-server-archive.int.test.ts',
      'test/real-server-convergence.int.test.ts',
      'test/real-server-exactly-once.int.test.ts',
      'test/workflow-real-server.int.test.ts',
    ]);
  });

  it('prints the client step’s real seed', () => {
    expect(CLIENT_SEED).toBe(PROPERTY_SEED);
  });
});
