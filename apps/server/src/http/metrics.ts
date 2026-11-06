/**
 * Opt-in Prometheus metrics (`METRICS_ENABLED=true`, SPEC-004 §10).
 * `/metrics` is unauthenticated: keep it off the public proxy, or leave it disabled.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export function registerMetrics(app: FastifyInstance): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'surface_' });

  const httpDuration = new Histogram({
    name: 'surface_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    // Label by route pattern, not raw URL, to keep cardinality bounded.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) =>
    reply.header('content-type', registry.contentType).send(await registry.metrics()),
  );

  return registry;
}
