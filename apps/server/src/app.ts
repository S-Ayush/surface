/**
 * Fastify app factory. Pure construction: no listening, no signal handlers,
 * so tests can build an app and drive it with `inject()`.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildInfo, defaultWebDir, type BuildInfo } from './build-info.js';
import type { Config } from './config.js';
import { registerErrorHandler } from './http/errors.js';
import { registerHealthRoutes } from './http/health.js';
import { registerMetrics } from './http/metrics.js';
import { registerWebApp } from './http/static.js';
import type { Lifecycle } from './lifecycle.js';

export interface AppDeps {
  config: Config;
  lifecycle: Lifecycle;
  logger: Logger;
  info?: BuildInfo;
}

/** Accept a caller's X-Request-Id only if it is short and safe to log. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp({
  config,
  lifecycle,
  logger,
  info = buildInfo(),
}: AppDeps): Promise<FastifyInstance> {
  // Widened to Fastify's base logger type so the instance keeps its default generics.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustProxy,
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

  registerErrorHandler(app);
  if (config.metricsEnabled) registerMetrics(app);
  registerHealthRoutes(app, lifecycle, info);
  await registerWebApp(app, config.webDir ?? defaultWebDir());

  return app;
}
