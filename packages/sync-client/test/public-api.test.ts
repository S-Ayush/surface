/**
 * The package's public surface (ADR-0015): views read through `SyncStore` and
 * a read-only pool. The pool's writers, instance internals and storage
 * implementations stay inside the package.
 */
import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { ReadonlyPool } from '../src/index.js';
import { TEST_MODELS } from './support/models.js';
import { fakeFetch } from './support/server.js';

it('exports only the store, read helpers and errors', () => {
  expect(Object.keys(api).sort()).toEqual([
    'BootstrapFailedError',
    'CLIENT_PROTOCOL_VERSION',
    'ClientOutdatedError',
    'StorageUnavailableError',
    'SyncStore',
    'rowOf',
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
