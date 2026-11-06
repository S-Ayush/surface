// Client sync engine (SPEC-002 §5). Views use `SyncStore` and read through its
// `ReadonlyPool`; the pool's writers, instance internals and storage stay
// inside the package (ADR-0015). The socket (PLAN-002 S7) and the mutation
// queue (S8) build on this.
import { SYNC_PROTOCOL_VERSION } from '@surface/sync-protocol';

export const CLIENT_PROTOCOL_VERSION: number = SYNC_PROTOCOL_VERSION;

export { SyncStore } from './store.js';
export type { ReplicaPosition, SyncStatus, SyncStoreOptions } from './store.js';
export type { ModelKey, ReadonlyPool } from './pool.js';
export { rowOf } from './instance.js';
export type { AnyInstance, InstanceMeta, InstanceOf, ModelInstance } from './instance.js';
export type { IndexKey } from './indexes.js';
export { BootstrapFailedError, ClientOutdatedError } from './bootstrap.js';
export type { BootstrapProgress, FetchLike } from './bootstrap.js';
export { StorageUnavailableError } from './storage/rpc.js';
export type { StorageConnector } from './storage/open.js';
export type { LockMode, ReplicaLocks } from './locks.js';
