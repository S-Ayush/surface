import { globSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';

/** Export condition that points workspace packages at their TypeScript source. */
export const SOURCE_CONDITION = '@surface/source';

/**
 * Test tiers (plans README §6). The gate (`pnpm test`, `pnpm check`) runs a fraction of each
 * property's cases with its fixed seed and leaves timing tests out; `pnpm test:deep`
 * (`scripts/test-deep.mjs`) sets `SURFACE_TEST_TIER=deep`: every case, one fresh seed
 * (`SURFACE_PROPERTY_SEED`, printed by the script) and the timing tests.
 */
const DEEP = process.env.SURFACE_TEST_TIER === 'deep';

/** Share of each property's full case count the gate runs (`@surface/config/properties`). */
export const GATE_PROPERTY_SCALE = 0.2;

/** Wall-clock budgets (`*.perf.test.ts`) flake on a loaded machine: `pnpm test:deep` runs them. */
const TIMING_TESTS = '**/*.perf.test.{ts,tsx}';

function deepSeed() {
  const text = process.env.SURFACE_PROPERTY_SEED;
  if (text === undefined || text === '') return {};
  const seed = Number(text);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`SURFACE_PROPERTY_SEED must be an integer, like 123456 (got "${text}").`);
  }
  return { propertySeed: seed };
}

const provide = DEEP
  ? { testTier: 'deep', propertyScale: 1, ...deepSeed() }
  : { testTier: 'gate', propertyScale: GATE_PROPERTY_SCALE };

/**
 * Workers per Vitest run. Turbo runs several packages' tests at once, so the root scripts cap
 * each run (`SURFACE_VITEST_WORKERS`) to keep Turbo's concurrency × workers within the cores.
 * Unset (one package, one file), Vitest uses its default.
 */
function maxWorkers() {
  const text = process.env.SURFACE_VITEST_WORKERS;
  if (text === undefined || text === '') return {};
  const workers = Number(text);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`SURFACE_VITEST_WORKERS must be a positive integer, like 2 (got "${text}").`);
  }
  return { maxWorkers: workers };
}

const base = defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Integration tests (real Postgres) run separately via `test:int`.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.int.test.{ts,tsx}',
      ...(DEEP ? [] : [TIMING_TESTS]),
    ],
    provide,
    ...maxWorkers(),
    // A hung test still fails, after 30 s. Timing budgets belong in `*.perf.test.ts`
    // (`pnpm test:deep`), not in the default timeout (plans README §6).
    testTimeout: 30_000,
    // Unit tests may not reach the network: mock or fake every outside service. With
    // `isolate: false` the setup file runs once per file in a shared worker; it patches once.
    setupFiles: [fileURLToPath(new URL('./vitest-no-network.js', import.meta.url))],
  },
});

/**
 * Shared Vitest config for a workspace package.
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitest(overrides = {}) {
  return mergeConfig(base, overrides);
}

/** A test file that mocks a module (`vi.mock`, `vi.doMock`). */
const MOCKS_A_MODULE = /\bvi\.(?:do)?[mM]ock\(/;

/**
 * `surfaceVitest` with `isolate: false`: test files share a worker and its module cache, so a
 * package's module graph is imported once per worker instead of once per file, which is most of
 * the run time of the server and the web app.
 *
 * A file that mocks a module can't share: the mock never reaches modules another file already
 * imported, and the modules it imports while the mock is active stay cached, mocked, for the next
 * file. So the files under `root` that call `vi.mock` run in a second project, isolated as
 * before. Other global state a file changes (`vi.stubGlobal`, fake timers, the DOM) must be put
 * back by the file itself; `vi.restoreAllMocks` runs between files. The no-network guard is
 * installed once per worker and stays (`vitest-no-network.js`).
 * @param {string} root the package directory (`import.meta.dirname` of its `vitest.config.js`)
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitestShared(root, overrides = {}) {
  const config = mergeConfig(base, mergeConfig(overrides, { test: { isolate: false } }));
  const test = config.test ?? {};
  const mocking = filesMatching(root, test.include ?? [], test.exclude ?? [], MOCKS_A_MODULE);
  if (mocking.length === 0) return config;
  const shared = mergeConfig(config, { test: { name: 'shared' } });
  shared.test = { ...shared.test, exclude: [...(test.exclude ?? []), ...mocking] };
  const isolated = mergeConfig(config, { test: { name: 'isolated', isolate: true } });
  isolated.test = { ...isolated.test, include: mocking };
  // `maxWorkers` is a run-wide option: it stays on the root config.
  return { test: { projects: [shared, isolated], ...maxWorkers() } };
}

/** Files under `root` matching `include` and none of `exclude`, whose text matches `pattern`. */
function filesMatching(root, include, exclude, pattern) {
  return include
    .flatMap((glob) => globSync(glob, { cwd: root }))
    .filter((file) => !exclude.some((glob) => matchesGlob(file, glob)))
    .filter((file) => pattern.test(readFileSync(join(root, file), 'utf8')))
    .sort();
}

const integrationBase = defineConfig({
  resolve: base.resolve,
  ssr: base.ssr,
  test: {
    include: ['src/**/*.int.test.{ts,tsx}', 'test/**/*.int.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration tests keep their full case counts; only the tier's seed and sizes apply.
    provide: { ...provide, propertyScale: 1 },
    ...maxWorkers(),
    // Containers and real databases are slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

/**
 * Vitest config for integration tests (`*.int.test.ts`, run by `test:int`).
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitestIntegration(overrides = {}) {
  return mergeConfig(integrationBase, overrides);
}
