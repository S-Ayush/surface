// React bindings for the sync store (ADR-0017): hooks for PLAN-005 and the
// sync inspector panel (SPEC-002 §5.4).
export { SyncStoreProvider, useSyncStore } from './context.js';
export {
  useBootstrapProgress,
  useConnectionState,
  useInspector,
  usePendingCount,
  useStorageWarning,
  useTeamLoadState,
} from './hooks.js';
export { SyncInspector } from './SyncInspector.js';
export type { SyncInspectorProps } from './SyncInspector.js';
export { inspectorAllowed } from './gate.js';
export type { InspectorGate } from './gate.js';
