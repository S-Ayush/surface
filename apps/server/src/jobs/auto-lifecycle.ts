/**
 * What `auto-archive` and `auto-close` share (SPEC-015 §6.3): one issue per operation, through the
 * executor as the system actor, with the outcome mapped for `runDailyBatch`, and the counters.
 * Each job's own file has its selection SQL and its schedule.
 */
import { systemActor } from '@surface/domain';
import { Counter, type Registry } from 'prom-client';
import type { Executor } from '../executor/execute.js';
import { loggableError } from '../executor/log-error.js';
import type { ItemOutcome } from './daily-batch.js';

export interface AutoLog {
  warn(object: object, message: string): void;
  debug(object: object, message: string): void;
}

/** The two counters of a job (`surface_<what>_total` and `surface_<what>_failures_total`). */
export interface AutoMetrics {
  done(): void;
  failed(): void;
}

export const noAutoMetrics: AutoMetrics = { done: () => undefined, failed: () => undefined };

export function autoCounters(
  registry: Registry,
  names: { readonly total: string; readonly failures: string; readonly what: string },
): AutoMetrics {
  const total = new Counter({
    name: names.total,
    help: `Issues the ${names.what} job changed`,
    registers: [registry],
  });
  const failures = new Counter({
    name: names.failures,
    help: `Issues the ${names.what} job failed on; it tries them again on its next run`,
    registers: [registry],
  });
  return { done: () => total.inc(), failed: () => failures.inc() };
}

/**
 * Runs `operation` on one issue. Ok is done. `CONFLICT` (no longer due: edited, restored,
 * archived or deleted since selection, E19–E21) and `NOT_FOUND` (purged meanwhile) are skipped,
 * not failures. Anything else, or a throw, is a failure: counted, logged with the issue id, and
 * tried again on the next run.
 */
export async function runAutoOperation(
  executor: Pick<Executor, 'execute'>,
  operation: 'issue.autoArchive' | 'issue.autoClose',
  issueId: string,
  metrics: AutoMetrics,
  log: AutoLog,
): Promise<ItemOutcome> {
  const job = operation === 'issue.autoArchive' ? 'auto-archive' : 'auto-close';
  let code: string;
  try {
    const result = await executor.execute(operation, { issue: issueId }, systemActor());
    if (result.ok) {
      metrics.done();
      return 'done';
    }
    code = result.error.code;
  } catch (error) {
    // The executor answers every operation error; a throw is the pool or the process.
    log.warn({ issueId, err: loggableError(error) }, `${job} failed on an issue`);
    metrics.failed();
    return 'failed';
  }
  if (code === 'CONFLICT' || code === 'NOT_FOUND') {
    log.debug({ issueId, code }, `${job} skipped an issue no longer due`);
    return 'skipped';
  }
  metrics.failed();
  // The executor logged the cause with its correlation id; the issue id is enough here.
  log.warn({ issueId, code }, `${job} could not change an issue`);
  return 'failed';
}
