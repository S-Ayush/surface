/**
 * Fastify app factory. Pure construction: no listening, no signal handlers,
 * so tests can build an app and drive it with `inject()`.
 */
import { randomUUID } from 'node:crypto';
import type { OperationRegistry } from '@surface/operations';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';
import { buildInfo, defaultWebDir, type BuildInfo } from './build-info.js';
import type { Config } from './config.js';
import type { Executor } from './executor/execute.js';
import { registerErrorHandler } from './http/errors.js';
import { registerHealthRoutes } from './http/health.js';
import { registerMetrics } from './http/metrics.js';
import { registerOpsRoutes, type ActorResolver } from './http/ops.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { readIndexHtml, registerWebApp } from './http/static.js';
import type { Lifecycle } from './lifecycle.js';

/** The operations API (SPEC-003 §9). Left out by tests that don't need a database. */
export interface OpsDeps {
  registry: OperationRegistry;
  resolveActor: ActorResolver;
  /** Built here so the executor records into the app's `/metrics` registry, when enabled. */
  createExecutor: (metrics: Registry | undefined) => Executor;
}

export interface AppDeps {
  config: Config;
  lifecycle: Lifecycle;
  logger: Logger;
  info?: BuildInfo;
  ops?: OpsDeps;
}

/**
 * SPEC-004 §7, D6: `TRUST_PROXY=true` trusts exactly the one reverse proxy in front, so the
 * client address is the X-Forwarded-For entry that proxy appended. Fastify's `true` trusts every
 * hop (the client writes the left-most entry itself), and a hop count (`1`) trusts none in
 * Fastify 5.12+, so the rule is a function: only the socket peer (hop 0) is a proxy.
 */
const trustNearestHop = (_address: string, hop: number): boolean => hop === 0;

/** Accept a caller's X-Request-Id only if it is short and safe to log. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp({
  config,
  lifecycle,
  logger,
  info = buildInfo(),
  ops,
}: AppDeps): Promise<FastifyInstance> {
  // Widened to Fastify's base logger type so the instance keeps its default generics.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustProxy ? trustNearestHop : false,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'reqId' }),
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // While draining, close keep-alive sockets after each response so shutdown
    // does not wait for idle connections that finished their last request.
    if (lifecycle.state === 'draining') reply.header('connection', 'close');
  });

  const webDir = config.webDir ?? defaultWebDir();
  const indexHtml = readIndexHtml(webDir);
  registerSecurityHeaders(app, indexHtml);
  registerErrorHandler(app);
  const metrics = config.metricsEnabled ? registerMetrics(app) : undefined;
  registerHealthRoutes(app, lifecycle, info);
  if (ops) {
    registerOpsRoutes(app, {
      executor: ops.createExecutor(metrics),
      registry: ops.registry,
      resolveActor: ops.resolveActor,
      lifecycle,
      version: info.version,
    });
  }
  await registerWebApp(app, webDir, indexHtml !== undefined);

  return app;
}
