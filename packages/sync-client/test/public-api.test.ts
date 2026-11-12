/**
 * The package's public surface (ADR-0015): views read through `SyncStore` and
 * a read-only pool. The pool's writers, instance internals and storage
 * implementations stay inside the package.
 */
import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { ReadonlyPool } from '../src/index.js';
import type { debugRename } from './support/ops.js';
import { TEST_MODELS } from './support/models.js';
import { fakeFetch } from './support/server.js';

it('exports only the store, read helpers, UI bindings and errors', () => {
  expect(Object.keys(api).sort()).toEqual([
    'BootstrapFailedError',
    'CLIENT_PROTOCOL_VERSION',
    'ClientOutdatedError',
    'InvalidInputError',
    'StorageUnavailableError',
    'SyncStore',
    // Framework-free bindings and selectors (ADR-0017).
    'bootstrapOf',
    'connectionOf',
    'inspect',
    'observe',
    'pendingCountOf',
    'rowOf',
    'storageUsage',
    'storageWarningOf',
  ]);
});

it('gives views a pool they cannot write to', () => {
  const store = new api.SyncStore({
    models: TEST_MODELS,
    workspaceId: 'ws',
    userId: 'u',
    fetch: fakeFetch(),
  });
  expectTypeOf(store.pool).toEqualTypeOf<ReadonlyPool>();
  expectTypeOf(store.pool).not.toHaveProperty('applyBase');
  expectTypeOf(store.pool).not.toHaveProperty('setOverlay');
});

it('types dispatch by the operation: its input and options in, an outcome out', () => {
  const store = new api.SyncStore({
    models: TEST_MODELS,
    workspaceId: 'ws',
    userId: 'u',
    fetch: fakeFetch(),
  });
  type Dispatch = (
    op: typeof debugRename,
    input: { id: string; title: string },
    options?: api.DispatchOptions,
  ) => Promise<api.MutationOutcome>;
  expectTypeOf<Parameters<typeof store.dispatch<typeof debugRename>>>().toEqualTypeOf<
    Parameters<Dispatch>
  >();
  expectTypeOf<ReturnType<typeof store.dispatch<typeof debugRename>>>().toEqualTypeOf<
    ReturnType<Dispatch>
  >();
  expectTypeOf(store.pending).toEqualTypeOf<readonly api.PendingView[]>();
  expectTypeOf(store.rejections).toEqualTypeOf<readonly api.Rejection[]>();
});
