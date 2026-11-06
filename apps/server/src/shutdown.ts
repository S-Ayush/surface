/**
 * Graceful shutdown (SPEC-004 §8):
 *  1. `/readyz` → 503 (state `draining`).
 *  2. `connections` hooks run (WebSockets closed with 1012, from PLAN-002).
 *  3. HTTP stops accepting; in-flight requests drain for up to `drainTimeoutMs`,
 *     then remaining connections are cut.
 *  4. `resources` hooks run (job worker, DB pool).
 * The process exits 0, or is forced out with exit 1 after `forceExitMs`.
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Lifecycle, ShutdownPhase } from './lifecycle.js';

export const DRAIN_TIMEOUT_MS = 10_000;
export const FORCE_EXIT_MS = 15_000;

export interface ShutdownOptions {
  app: FastifyInstance;
  lifecycle: Lifecycle;
  log: Logger;
  drainTimeoutMs?: number;
}

export async function gracefulShutdown({
  app,
  lifecycle,
  log,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
}: ShutdownOptions): Promise<void> {
  lifecycle.beginDraining();
  await runHooks(lifecycle, 'connections', log);

  const closed = app.close();
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), drainTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!drained) {
    log.warn({ drainTimeoutMs }, 'in-flight requests did not finish in time; closing connections');
    app.server.closeAllConnections();
    await closed;
  }

  await runHooks(lifecycle, 'resources', log);
}

async function runHooks(lifecycle: Lifecycle, phase: ShutdownPhase, log: Logger): Promise<void> {
  for (const hook of lifecycle.shutdownHooks(phase)) {
    try {
      await hook.run();
    } catch (err) {
      // Keep going: one failing hook must not block the rest of the shutdown.
      log.error({ err, hook: hook.name }, 'shutdown hook failed');
    }
  }
}

/** Wire SIGTERM/SIGINT and fatal errors to a graceful (then forced) exit. */
export function installProcessHandlers(options: ShutdownOptions & { forceExitMs?: number }): void {
  const { log, forceExitMs = FORCE_EXIT_MS } = options;
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.warn({ signal }, 'second signal received; exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    setTimeout(() => {
      log.error({ forceExitMs }, 'shutdown took too long; forcing exit');
      process.exit(1);
    }, forceExitMs).unref();

    gracefulShutdown(options).then(
      () => {
        log.info('shutdown complete');
        process.exit(0);
      },
      (err: unknown) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
}
