/** Per-operation metrics (SPEC-003 §6 step 14), on the `/metrics` registry when it is enabled. */
import { Histogram, type Registry } from 'prom-client';

export interface OperationMetrics {
  observe(op: string, kind: string, outcome: string, seconds: number): void;
}

export const noMetrics: OperationMetrics = { observe: () => undefined };

export function operationMetrics(registry: Registry): OperationMetrics {
  const histogram = new Histogram({
    name: 'surface_operation_duration_seconds',
    help: 'Operation execution time in seconds, by operation, kind and outcome (ok or error code)',
    labelNames: ['op', 'kind', 'outcome'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  return {
    observe: (op, kind, outcome, seconds) => histogram.observe({ op, kind, outcome }, seconds),
  };
}

/** Sync-lock hold time, from taking `LOCKS.sync` to commit (SPEC-002 §10: p95 < 2 ms). */
export interface SyncMetrics {
  observeLockHold(seconds: number): void;
}

export const noSyncMetrics: SyncMetrics = { observeLockHold: () => undefined };

export function syncMetrics(registry: Registry): SyncMetrics {
  const histogram = new Histogram({
    name: 'surface_sync_lock_hold_seconds',
    help: 'Time the sync-log lock is held, from taking it to commit, in seconds',
    buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1],
    registers: [registry],
  });
  return { observeLockHold: (seconds) => histogram.observe(seconds) };
}
