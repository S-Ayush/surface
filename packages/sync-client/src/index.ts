// Client sync engine (SPEC-002 §5). Views use `SyncStore` and read through its
// `ReadonlyPool`; the pool's writers, instance internals and storage stay
// inside the package (ADR-0015). Changes go through `store.dispatch` (the
// mutation queue and optimistic overlay, PLAN-002 S8); `store.refs` resolves
// references the way the server does.
import { SYNC_PROTOCOL_VERSION } from '@surface/sync-protocol';

export const CLIENT_PROTOCOL_VERSION: number = SYNC_PROTOCOL_VERSION;

export { SyncStore } from './store.js';
export type {
  ConnectionOptions,
  PacketView,
  ReplicaPosition,
  RoundTrip,
  SyncStatus,
  SyncStoreOptions,
} from './store.js';
// Framework-free bindings for the UI hooks and the inspector (ADR-0017).
export { observe } from './observe.js';
export type { ExternalSource } from './observe.js';
export {
  bootstrapOf,
  connectionOf,
  inspect,
  pendingCountOf,
  storageUsage,
  storageWarningOf,
} from './inspect.js';
export type {
  BootstrapSnapshot,
  ConnectionSnapshot,
  InspectorSnapshot,
  StorageEstimator,
} from './inspect.js';
export { InvalidInputError } from './queue.js';
export type { MutationOutcome, PendingView, Rejection } from './queue.js';
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
