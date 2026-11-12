/**
 * Fastify app factory. Pure construction: no listening, no signal handlers,
 * so tests can build an app and drive it with `inject()`.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { OperationRegistry } from '@surface/operations';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';
import { buildInfo, defaultWebDir, type BuildInfo } from './build-info.js';
import type { AttemptStore } from './auth/attempts.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAccountRoutes } from './handlers/account/routes.js';
import { localBlobStore } from './files/blob-store.js';
import { registerFileRoutes } from './files/routes.js';
import type { SessionAuth } from './auth/sessions.js';
import type { AuthStore } from './auth/store.js';
import type { EmailOutbox } from './jobs/email.js';
import type { WithTransaction } from './executor/transaction.js';
import type { Config } from './config.js';
import type { Executor } from './executor/execute.js';
import { trustReverseProxy } from './http/client-address.js';
import { registerErrorHandler } from './http/errors.js';
import { registerHealthRoutes } from './http/health.js';
import { registerMetrics } from './http/metrics.js';
import { registerOpsRoutes, type ActorResolver } from './http/ops.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { readIndexHtml, registerWebApp } from './http/static.js';
import { registerSetupRoutes, type SetupGate } from './setup/routes.js';
import type { SetupStore } from './setup/store.js';
import { hubMetrics } from './sync/hub.js';
import { registerSyncRoutes, type SyncRoutesDeps } from './sync/routes.js';
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
  /** The sync routes (PLAN-002 S3+). Left out by tests that don't need a database. */
  sync?: SyncDeps;
  /** First-run setup and its guard (PLAN-001 S2). Left out by tests that don't need it. */
  setup?: { store: SetupStore; gate: SetupGate };
  /** Sign-in, sessions and CSRF (PLAN-001 S3). Left out by tests that don't need them. */
  auth?: AuthDeps;
}

export interface AuthDeps {
  auth: SessionAuth;
  store: AuthStore;
  attempts: AttemptStore;
  /** Closes sessions' sockets on sign-out (the sync hub, where it runs). */
  closeSessions?: (sessionIds: readonly string[]) => void;
  /** Queues email on a route's transaction (magic link, reset; PLAN-001 S4). */
  email?: EmailOutbox;
  /** A transaction for a route's writes and the email it queues, together. */
  withTransaction?: WithTransaction;
  now?: () => Date;
  /** Password checking, for tests that count the work (AC-5). */
  verify?: (hash: string, password: string) => Promise<boolean>;
}

/** The executor comes from `ops`, shared with the operations API. */
export type SyncDeps = Omit<SyncRoutesDeps, 'lifecycle' | 'executor'>;

/** Accept a caller's X-Request-Id only if it is short and safe to log. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp({
  config,
  lifecycle,
  logger,
  info = buildInfo(),
  ops,
  sync,
  setup,
  auth,
}: AppDeps): Promise<FastifyInstance> {
  // Widened to Fastify's base logger type so the instance keeps its default generics.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustProxy ? trustReverseProxy : false, // SPEC-004 §7, D6
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
  registerSecurityHeaders(app, indexHtml, { https: config.secureCookies });
  registerErrorHandler(app);
  const metrics = config.metricsEnabled ? registerMetrics(app) : undefined;
  registerHealthRoutes(app, lifecycle, info);
  // Its guard is an `onRequest` hook: registered before the routes it closes until setup is done.
  if (setup) {
    registerSetupRoutes(app, {
      ...setup,
      lifecycle,
      secureCookies: config.secureCookies,
      sessionSecret: config.sessionSecret,
    });
  }
  // After the setup guard, before the routes: the CSRF check is an `onRequest` hook too.
  if (auth) {
    registerAuthRoutes(app, {
      ...auth,
      lifecycle,
      secureCookies: config.secureCookies,
      sessionSecret: config.sessionSecret,
      allowedOrigin: new URL(config.publicUrl).origin,
      smtpEnabled: config.smtp !== null,
      setupComplete: setup ? () => setup.gate.isComplete() : () => Promise.resolve(true),
    });
    // Magic links and password reset (PLAN-001 S4, session E): they need the email outbox and a
    // transaction, so tests that build the app without them get no such routes.
    if (auth.email && auth.withTransaction) {
      registerAccountRoutes(app, {
        auth: auth.auth,
        lifecycle,
        secureCookies: config.secureCookies,
        sessionSecret: config.sessionSecret,
        allowedOrigin: new URL(config.publicUrl).origin,
        publicUrl: config.publicUrl,
        email: auth.email,
        withTransaction: auth.withTransaction,
        ...(auth.closeSessions ? { closeSessions: auth.closeSessions } : {}),
        ...(auth.now ? { now: auth.now } : {}),
      });
    }
    // Avatars and the logo (PLAN-001 S6, session E; ADR-0014): bytes on the uploads volume.
    if (auth.withTransaction) {
      registerFileRoutes(app, {
        auth: auth.auth,
        lifecycle,
        withTransaction: auth.withTransaction,
        blobs: localBlobStore(path.join(config.dataDir, 'uploads')),
        log: logger,
        uploadMaxMb: config.uploadMaxMb,
      });
    }
  }
  // One executor for the operations API and `POST /sync/mutate`: one rate limiter, one set of metrics.
  const executor = ops?.createExecutor(metrics);
  if (ops && executor) {
    registerOpsRoutes(app, {
      executor,
      registry: ops.registry,
      resolveActor: ops.resolveActor,
      lifecycle,
      version: info.version,
    });
  }
  if (sync) {
    if (sync.hub && metrics) sync.hub.useMetrics(hubMetrics(metrics));
    registerSyncRoutes(app, {
      ...sync,
      ...(executor ? { executor } : {}),
      lifecycle,
      allowedOrigin: new URL(config.publicUrl).origin,
    });
  }
  await registerWebApp(app, webDir, indexHtml !== undefined);

  return app;
}
