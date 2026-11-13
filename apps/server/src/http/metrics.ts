/**
 * Opt-in Prometheus metrics (`METRICS_ENABLED=true`, SPEC-004 §10).
 * `/metrics` is unauthenticated: keep it off the public proxy, or leave it disabled.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { loggableError } from '../executor/log-error.js';
import type { FileStorageStats } from '../files/store.js';

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

/**
 * Stored file bytes and the `blob_release` backlog (SPEC-014 §10, PLAN-014 S3), read from the
 * database on each scrape. A failed read keeps the last value and logs a warning: a scrape never
 * fails because of it.
 */
export function registerFileMetrics(
  registry: Registry,
  stats: () => Promise<FileStorageStats>,
  log: { warn(object: object, message: string): void },
): void {
  // One query (and at most one warning) per scrape: the registry collects both gauges at once, so
  // the second shares the first one's read while it is in flight.
  let inFlight: Promise<FileStorageStats | undefined> | undefined;
  const shared = () => {
    inFlight ??= stats()
      .catch((error: unknown) => {
        log.warn({ err: loggableError(error) }, 'file metrics unavailable');
        return undefined;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const read = async (pick: (stats: FileStorageStats) => number, gauge: Gauge) => {
    const values = await shared();
    if (values !== undefined) gauge.set(pick(values));
  };
  new Gauge({
    name: 'surface_files_stored_bytes',
    help: 'Bytes of uploaded files on the uploads volume, each stored key counted once',
    registers: [registry],
    async collect() {
      await read((s) => s.storedBytes, this);
    },
  });
  new Gauge({
    name: 'surface_files_blob_release_backlog',
    help: 'Storage keys waiting in blob_release for the files-cleanup drain',
    registers: [registry],
    async collect() {
      await read((s) => s.releaseBacklog, this);
    },
  });
}
