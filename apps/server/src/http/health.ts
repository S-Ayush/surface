/**
 * `/healthz`: liveness (200 while the event loop responds; Docker HEALTHCHECK).
 * `/readyz`:  readiness (200 only when ready and every check passes; SPEC-004 §8).
 */
import type { FastifyInstance } from 'fastify';
import type { BuildInfo } from '../build-info.js';
import type { Lifecycle } from '../lifecycle.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  lifecycle: Lifecycle,
  info: BuildInfo,
): void {
  // Probes hit these every few seconds; only log them when something is wrong.
  const quiet = { logLevel: 'warn' as const };

  app.get('/healthz', quiet, (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );

  app.get('/readyz', quiet, async (_request, reply) => {
    const report = await lifecycle.readiness();
    return reply
      .code(report.ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ status: report.status, ...report.checks, version: info.version });
  });
}
