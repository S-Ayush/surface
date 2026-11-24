import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';

/** Export condition that points workspace packages at their TypeScript source. */
export const SOURCE_CONDITION = '@surface/source';

/**
 * Test tiers (plans README §6, SPEC-004 D12), chosen by `SURFACE_TEST_TIER`:
 * - `gate` (unset; `pnpm test`, `pnpm check`): a share of each property's cases with its fixed
 *   seed, no timing tests;
 * - `deep` (`pnpm test:deep`'s first phase): every case, one fresh seed for the run
 *   (`SURFACE_PROPERTY_SEED`, printed), no timing tests;
 * - `timing` (its last phase, one package at a time): only the timing tests.
 */
const TIERS = ['gate', 'deep', 'timing'];
const TIER = process.env.SURFACE_TEST_TIER || 'gate';
if (!TIERS.includes(TIER)) {
  throw new Error(`SURFACE_TEST_TIER must be gate, deep or timing (got "${TIER}").`);
}

/** Share of each property's full case count the gate runs (`@surface/config/properties`). */
export const GATE_PROPERTY_SCALE = 0.2;

/** Wall-clock budgets (`*.perf.test.ts`) flake on a loaded machine: `pnpm test:deep` runs them. */
const TIMING_TESTS = '**/*.perf.test.{ts,tsx}';

/**
 * The deep tier's seed: `SURFACE_PROPERTY_SEED` (set by `scripts/test-deep.mjs`), or a fresh one
 * when a package's `test:deep` runs on its own, printed so a failure can be replayed.
 */
function deepSeed() {
  const text = process.env.SURFACE_PROPERTY_SEED;
  if (text === undefined || text === '') {
    const seed = Math.floor(Math.random() * 2 ** 31);
    process.stderr.write(
      `\ntest:deep: property seed ${seed} (replay: SURFACE_PROPERTY_SEED=${seed})\n\n`,
    );
    return { propertySeed: seed };
  }
  const seed = Number(text);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`SURFACE_PROPERTY_SEED must be an integer, like 123456 (got "${text}").`);
  }
  return { propertySeed: seed };
}

const provide =
  TIER === 'deep'
    ? { testTier: 'deep', propertyScale: 1, ...deepSeed() }
    : { testTier: TIER, propertyScale: GATE_PROPERTY_SCALE };

const tierFiles =
  TIER === 'timing'
    ? {
        include: ['src/**/*.perf.test.{ts,tsx}', 'test/**/*.perf.test.{ts,tsx}'],
        passWithNoTests: true,
      }
    : { include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'] };

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
    ...tierFiles,
    // Integration tests (real Postgres) run separately via `test:int`.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.int.test.{ts,tsx}',
      ...(TIER === 'timing' ? [] : [TIMING_TESTS]),
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

/** A module that mocks a module (`vi.mock`, `vi.doMock`). */
const MOCKS_A_MODULE = /\bvi\.(?:do)?[mM]ock\(/;
/** Relative module specifiers: `from './x.js'`, `import './x.js'`, `import('./x.js')`. */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * `surfaceVitest` with `isolate: false`: test files share a worker and its module cache, so a
 * package's module graph is imported once per worker instead of once per file, which is most of
 * the run time of the server and the web app.
 *
 * A file that mocks a module can't share: the mock never reaches modules another file already
 * imported, and the modules it imports while the mock is active stay cached, mocked, for the next
 * file. So the test files under `root` that call `vi.mock`, themselves or in a support or harness
 * file they import by a relative path outside `src/` (followed through further such imports),
 * run in a second project, isolated as before. The limit: a `vi.mock` in a module under `src/`
 * other than a test file, or reached only through a package import (`@surface/…`), isn't seen,
 * so keep mocks in test, support and harness files.
 *
 * Other global state a file changes (`vi.stubGlobal`, fake timers, the DOM, module singletons)
 * must be put back by the file itself or by a setup file in `sharedSetupFiles`. Those run before
 * each file of the shared project only: an isolated file starts fresh, and a setup file that
 * imports app modules would load them before that file's mocks. The no-network guard is installed
 * once per worker and stays (`vitest-no-network.js`).
 * @param {string} root the package directory (`import.meta.dirname` of its `vitest.config.js`)
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 * @param {{ sharedSetupFiles?: string[] }} [options]
 */
export function surfaceVitestShared(root, overrides = {}, { sharedSetupFiles = [] } = {}) {
  const config = mergeConfig(base, mergeConfig(overrides, { test: { isolate: false } }));
  const test = config.test ?? {};
  const mocking = filesMatching(root, test.include ?? [], test.exclude ?? [], MOCKS_A_MODULE);
  const shared = mergeConfig(config, { test: { setupFiles: sharedSetupFiles } });
  if (mocking.length === 0) return shared;
  shared.test = { ...shared.test, name: 'shared', exclude: [...(test.exclude ?? []), ...mocking] };
  const isolated = mergeConfig(config, { test: { name: 'isolated', isolate: true } });
  isolated.test = { ...isolated.test, include: mocking };
  // `maxWorkers` is a run-wide option: it stays on the root config.
  return { test: { projects: [shared, isolated], ...maxWorkers() } };
}

/**
 * Test files under `root` matching `include` and none of `exclude` whose text, or the text of a
 * file they reach through relative imports, matches `pattern`.
 */
function filesMatching(root, include, exclude, pattern) {
  const texts = new Map();
  const read = (file) => texts.get(file) ?? texts.set(file, readFileSync(file, 'utf8')).get(file);
  // Depth-first over relative imports into test code: support, harness and fixture files live
  // outside `src/` (app code doesn't mock). `seen` stops at cycles.
  const appCode = join(root, 'src') + sep;
  const reaches = (file, seen) => {
    if (seen.has(file)) return false;
    seen.add(file);
    const text = read(file);
    return (
      pattern.test(text) ||
      [...text.matchAll(RELATIVE_IMPORT)].some(([, specifier]) => {
        const target = sourceFile(join(dirname(file), specifier));
        return target !== undefined && !target.startsWith(appCode) && reaches(target, seen);
      })
    );
  };
  return include
    .flatMap((glob) => globSync(glob, { cwd: root }))
    .filter((file) => !exclude.some((glob) => matchesGlob(file, glob)))
    .filter((file) => reaches(join(root, file), new Set()))
    .sort();
}

/** The source file an ESM specifier like `./x.js` names (TypeScript keeps the `.js`), if any. */
function sourceFile(path) {
  const stem = path.replace(/\.(?:js|jsx|ts|tsx|mjs)$/, '');
  return [`${stem}.ts`, `${stem}.tsx`, path].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
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
