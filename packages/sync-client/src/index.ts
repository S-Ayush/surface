// Client sync engine (SPEC-002 §5). Views use `SyncStore` and read through its
// `ReadonlyPool`; the pool's writers, instance internals and storage stay
// inside the package (ADR-0015). The mutation queue (PLAN-002 S8) builds on
// this.
import { SYNC_PROTOCOL_VERSION } from '@surface/sync-protocol';

export const CLIENT_PROTOCOL_VERSION: number = SYNC_PROTOCOL_VERSION;

export { SyncStore } from './store.js';
export type { ConnectionOptions, ReplicaPosition, SyncStatus, SyncStoreOptions } from './store.js';
export type {
  ConnectionState,
  OnlineSource,
  SocketConnection,
  SocketFactory,
  SocketHandlers,
  Timers,
} from './socket.js';
export type { ModelKey, ReadonlyPool } from './pool.js';
export { rowOf } from './instance.js';
export type { AnyInstance, InstanceMeta, InstanceOf, ModelInstance } from './instance.js';
export type { IndexKey } from './indexes.js';
export { BootstrapFailedError, ClientOutdatedError } from './bootstrap.js';
export type { BootstrapProgress, FetchLike } from './bootstrap.js';
export { StorageUnavailableError } from './storage/rpc.js';
export type { StorageConnector } from './storage/open.js';
export type { LockMode, ReplicaLocks } from './locks.js';
