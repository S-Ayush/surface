/**
 * Test doubles for other workspaces' tests (`@surface/sync-client/testing`),
 * used by the sync simulation (`tests/sync-sim`, ADR-0016). Only `tests/` may
 * import this entry (`.dependency-cruiser.cjs`); app code never does.
 */
export { FakeHub, HubConnection } from './hub.js';
export { bootstrapFrames } from './server.js';
export { IndexedDbStorage } from '../../src/storage/indexeddb.js';
export type { PendingRecord, QueueWrite, SyncStorage } from '../../src/storage/types.js';
