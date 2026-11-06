/**
 * `surface serve`: start the server (SPEC-004 §8 startup sequence).
 */
import { buildApp } from './app.js';
import { buildInfo } from './build-info.js';
import type { Config } from './config.js';
import { Lifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { installProcessHandlers } from './shutdown.js';

export async function serve(config: Config): Promise<void> {
  const logger = createLogger(config);
  const info = buildInfo();
  const lifecycle = new Lifecycle();
  const app = await buildApp({ config, lifecycle, logger, info });

  installProcessHandlers({ app, lifecycle, log: logger });

  // Listen first so /healthz answers and /readyz reports 503 while starting.
  await app.listen({ port: config.port, host: config.host });

  // PLAN-004 S3: wait for the database, run migrations, check Postgres + extensions.
  // PLAN-001 S2: log the setup token while setup is incomplete.
  // Job worker and sync hub start here in later slices (by SURFACE_ROLE).

  lifecycle.markReady();
  logger.info(
    { version: info.version, commit: info.commit, url: config.publicUrl, role: config.role },
    'Surface is ready',
  );
}
