import { surfaceVitestIntegration } from '@surface/config/vitest';
import { mergeConfig } from 'vitest/config';
import { SIM_DEFAULTS } from './vitest.config.js';

/**
 * The properties against the real server (PLAN-002 S9 part 2): 20 cases each on every
 * `pnpm test:int`, since each case starts a server on its own database. The fake hub
 * (`pnpm test`, `pnpm sim`) gives the depth.
 *
 * Two phases. First, alone and one file at a time, the files whose assertions depend on how fast
 * the server answers, not only on the seed: a replay compared with the first run, a burst that
 * must pass the rate limit mid-batch (`real-server.int.test.ts`), a seed picked because its delays
 * put a failed fetch before a socket's close (`lifecycle-real-server.int.test.ts`), and a coverage
 * check that held only narrowly before (`attachments-real-server.int.test.ts`: some stored
 * attachment has a preview). Then every other file in parallel: each case starts its own server
 * (port 0) on its own database (a random name cloned from `sync_sim_template`), so files share
 * nothing but the cluster.
 */
const TIMING_SENSITIVE = [
  'test/real-server.int.test.ts',
  'test/lifecycle-real-server.int.test.ts',
  'test/attachments-real-server.int.test.ts',
];

/**
 * Files at once in the parallel phase when `SURFACE_VITEST_WORKERS` doesn't say: each holds a
 * server with its pools, and the cluster's connections are limited (Postgres' default is 100).
 */
const DEFAULT_WORKERS = 4;

const common = surfaceVitestIntegration({
  test: {
    environment: 'node',
    // Both phases share one cluster and template (`global-setup.ts` starts it once).
    globalSetup: ['./test/support/global-setup.ts'],
    provide: { ...SIM_DEFAULTS, simRuns: 20 },
    // The slowest property takes about a minute alone; the margin covers a loaded machine.
    testTimeout: 5 * 60_000,
  },
});
const { maxWorkers = DEFAULT_WORKERS, ...project } = common.test ?? {};

/** One phase. `include` is set, not merged: `mergeConfig` would add to the base list. */
function phase(name, groupOrder, test) {
  const config = mergeConfig(
    { ...common, test: project },
    { test: { name, sequence: { groupOrder } } },
  );
  config.test = { ...config.test, ...test };
  return config;
}

/**
 * Every file in one project, one file at a time, with `test` on top: `pnpm sim:deep`'s real step
 * (`scripts/sim-deep-plan.mjs`). Its runs, seed and timeout can't go through the phases below: a
 * project's own `provide` and timeout win over the root's, so a 1,000-case run would run 20.
 * One file at a time also keeps the timing-sensitive files' conditions through hours of cases.
 */
export function serialConfig(test) {
  return mergeConfig({ ...common, test: project }, { test: { ...test, fileParallelism: false } });
}

export default {
  ...common,
  test: {
    maxWorkers,
    projects: [
      phase('timing-sensitive', 0, { include: TIMING_SENSITIVE, fileParallelism: false }),
      phase('parallel', 1, { exclude: [...(project.exclude ?? []), ...TIMING_SENSITIVE] }),
    ],
  },
};
