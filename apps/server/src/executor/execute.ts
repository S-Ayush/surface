/**
 * The operation executor (SPEC-003 §6): every state change and every query from the web
 * client, the HTTP API and MCP runs through `execute()` (CLAUDE.md rule 1).
 *
 *  1–2  look up the operation (internal ones only for users outside production)
 *  3    API-key scope                         → FORBIDDEN
 *  4    rate limit                            → RATE_LIMITED
 *  5    validate input                        → INVALID_INPUT
 *  6    BEGIN (read-only for queries); claim a `clientMutationId` or replay its result
 *  7    resolve references                    → NOT_FOUND | INVALID_INPUT
 *  8    permission                            → FORBIDDEN
 *  9    handler
 *  10   checks (automations, invariants), then output validation
 *  11   repo flush + outbox (mutations)
 *  12   COMMIT (retrying serialization failures and deadlocks, E5)
 *  13   result, projected to `fields` (§7.2)
 *  14   log + metrics
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import {
  evaluatePermission,
  fieldsProblem,
  shapeOutput,
  type AnyOperation,
  type OperationRegistry,
} from '@surface/operations';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';
import type { z } from 'zod';
import type { Pool } from '../db/pool.js';
import { eventOutbox } from '../db/schema/index.js';
import { uuidv7 } from '../db/uuidv7.js';
import { queryHelpers, type DomainEvent, type Handler, type HandlerContext } from './context.js';
import { INTERNAL_MESSAGE, SurfaceError, type ErrorIssue, type OperationError } from './errors.js';
import { checkClientMutationId, claim, idempotencyOwner, record } from './idempotency.js';
import { keyScopeProblem, narrowToKeyTeams, refOutsideKeyTeams } from './key-scope.js';
import { loggableError } from './log-error.js';
import { noMetrics, operationMetrics, type OperationMetrics } from './metrics.js';
import { unlimited, type RateLimiter } from './rate-limit.js';
import { refNotFound, refPlan, resolveRefs, single, valueAt } from './refs/resolve.js';
import { passthroughRepo, type RepoFactory, type RowChange, type TransactionRepo } from './repo.js';
import { nearestNames } from './suggest.js';
import { inTransaction, jitterBackoff, postgresCode } from './transaction.js';

/** Step 10: automations and invariant checks, run after the handler inside the transaction. */
export type PostHandlerCheck = (state: {
  readonly op: AnyOperation;
  readonly actor: Actor;
  readonly tx: NodePgDatabase;
  readonly repo: TransactionRepo;
  readonly changes: readonly RowChange[];
  readonly events: readonly DomainEvent[];
}) => Promise<void>;

export interface ExecutorDeps {
  readonly pool: Pool;
  readonly registry: OperationRegistry;
  readonly handlers: readonly Handler[];
  readonly log: Logger;
  /** Internal operations are callable (by user actors) only when this is true: dev and test. */
  readonly allowInternal: boolean;
  readonly metrics?: Registry;
  readonly rateLimiter?: RateLimiter;
  readonly repoFactory?: RepoFactory;
  readonly checks?: readonly PostHandlerCheck[];
  /** Extra attempts after a serialization failure or deadlock (E5). Default 3. */
  readonly retries?: number;
  readonly backoff?: (attempt: number) => number;
  readonly clock?: () => Date;
}

interface TransactionOutcome {
  readonly result: unknown;
  readonly lastSyncId: number | undefined;
  readonly replayed?: true;
}

export interface ExecuteOptions {
  /** Ties the result, the log line and any error together; the HTTP request id when there is one. */
  readonly correlationId?: string;
  /** Sync clients only (SPEC-002 §4.4); passed to the repo flush. */
  readonly clientId?: string;
  readonly seq?: number;
  /** Dot-paths that project the result (SPEC-003 §7.2); checked before any work is done. */
  readonly fields?: readonly string[];
  /**
   * API and MCP mutations: a repeat within 24 h returns the stored result without running
   * again (SPEC-003 §9, AC-8). Ignored for queries and for actors without a user.
   */
  readonly clientMutationId?: string;
}

export type ExecuteResult =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly lastSyncId?: number;
      /** E8: a deprecated operation still runs and says what replaces it. */
      readonly deprecation?: { readonly replacedBy: string };
      /** The stored result of an earlier call with the same `clientMutationId`. */
      readonly replayed?: true;
    }
  | { readonly ok: false; readonly error: OperationError };

export interface Executor {
  /**
   * Operations the actor may call: internal ones only where allowed, and only what an API
   * key's scope permits (`GET /api/ops`, SPEC-003 §9).
   */
  operations(actor: Actor): AnyOperation[];
  execute(
    opName: string,
    rawInput: unknown,
    actor: Actor,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const handlers = handlerMap(deps.registry, deps.handlers);
  const metrics: OperationMetrics = deps.metrics ? operationMetrics(deps.metrics) : noMetrics;
  const rateLimiter = deps.rateLimiter ?? unlimited;
  const repoFactory = deps.repoFactory ?? passthroughRepo;
  const checks = deps.checks ?? [];
  const clock = deps.clock ?? (() => new Date());
  const transactionOptions = { retries: deps.retries ?? 3, backoff: deps.backoff ?? jitterBackoff };

  const callable = (def: AnyOperation, actor: Actor) =>
    !def.internal || (deps.allowInternal && actor.kind === 'user');

  async function run(
    def: AnyOperation,
    rawInput: unknown,
    actor: Actor,
    options: ExecuteOptions,
    log: Logger,
  ): Promise<ExecuteResult> {
    // 3. Key scope
    const scopeProblem = keyScopeProblem(def, actor);
    if (scopeProblem) throw new SurfaceError('FORBIDDEN', scopeProblem);

    // 4. Rate limit
    const rate = rateLimiter.take(actor, def.kind);
    if (!rate.allowed) {
      throw new SurfaceError(
        'RATE_LIMITED',
        `Too many requests. Try again in ${rate.retryAfterSeconds} s.`,
        { retryAfter: rate.retryAfterSeconds },
      );
    }

    // 5. Input
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) throw invalidInput(parsed.error);
    const input = parsed.data;
    const fields = options.fields;
    if (fields !== undefined) {
      const problem = fieldsProblem(def, fields);
      if (problem) {
        throw new SurfaceError('INVALID_INPUT', problem.message, {
          issues: [{ path: ['fields', problem.index], message: problem.message }],
        });
      }
    }

    const owner = def.kind === 'mutation' ? idempotencyOwner(actor) : undefined;
    const clientMutationId = owner === undefined ? undefined : options.clientMutationId;
    if (clientMutationId !== undefined) checkClientMutationId(clientMutationId);

    const handler = handlers.get(def.name);
    if (!handler) throw new Error(`No handler is registered for ${def.name}`);
    const viewer = narrowToKeyTeams(actor);

    // 6–12
    const { result, lastSyncId, replayed } = await inTransaction(
      deps.pool,
      { ...transactionOptions, readOnly: def.kind === 'query' },
      async (client): Promise<TransactionOutcome> => {
        const now = clock();
        const tx = drizzle({ client, casing: 'snake_case' });
        const repo = repoFactory(tx, now);
        const events: DomainEvent[] = [];

        // 6. Idempotency, before anything is read: a replay doesn't look at the present.
        if (owner !== undefined && clientMutationId !== undefined) {
          const claimed = await claim(tx, owner, clientMutationId, def.name);
          if ('replay' in claimed) return { ...claimed.replay, replayed: true };
        }

        // 7. References (visibility applied in SQL; key narrowing re-checked as a backstop)
        const refs = await resolveRefs(def, input, viewer, client);
        const outside = refOutsideKeyTeams(viewer, refPlan(def), refs);
        if (outside) {
          const { location, index } = outside;
          const value = valueAt(input, location.path);
          const list: readonly unknown[] | undefined = Array.isArray(value) ? value : undefined;
          const item = index !== undefined && list ? list[index] : value;
          const scope = location.scope === undefined ? undefined : single(refs[location.scope]);
          throw refNotFound(
            location.type,
            typeof item === 'string' ? item : String(item),
            index === undefined ? location.path : [...location.path, index],
            scope,
          );
        }

        // 8. Permission
        const permission = evaluatePermission(def, viewer, refs, input);
        if (!permission.allowed) throw new SurfaceError('FORBIDDEN', permission.reason);

        // 9. Handler
        const ctx: HandlerContext = {
          actor: viewer,
          refs,
          tx,
          repo,
          query: queryHelpers(tx, client, viewer, now),
          emit: (event) => void events.push(event),
          now: () => new Date(now),
          log,
        };
        const raw = await handler.run(ctx, input);

        // 10. Automations and invariants, then the output contract
        for (const check of checks) {
          await check({ op: def, actor: viewer, tx, repo, changes: repo.changes(), events });
        }
        const output = def.output.safeParse(raw);
        if (!output.success) {
          throw new Error(`${def.name} returned output that does not match its schema`, {
            cause: output.error,
          });
        }

        // 11. Sync log and outbox
        if (def.kind === 'query') {
          if (events.length > 0) throw new Error(`${def.name} is a query and cannot emit events`);
          return { result: output.data, lastSyncId: undefined };
        }
        const flushed = await repo.flush({
          ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
          ...(options.seq !== undefined ? { seq: options.seq } : {}),
        });
        if (events.length > 0) {
          await tx.insert(eventOutbox).values(
            events.map((event) => ({
              id: uuidv7(),
              type: event.type,
              occurredAt: now,
              actor: {
                kind: actor.kind,
                ...(actor.userId ? { userId: actor.userId } : {}),
                ...(actor.apiKey ? { apiKeyId: actor.apiKey.id } : {}),
              },
              subject: event.subject,
              changes: event.changes ?? null,
              data: event.data ?? null,
              lastSyncId: flushed.lastSyncId ?? null,
            })),
          );
        }
        if (owner !== undefined && clientMutationId !== undefined) {
          await record(tx, owner, clientMutationId, output.data, flushed.lastSyncId);
        }
        return { result: output.data, lastSyncId: flushed.lastSyncId };
      },
    );

    // 13. Result
    return {
      ok: true,
      result: fields === undefined ? result : shapeOutput(def, result, fields),
      ...(lastSyncId !== undefined ? { lastSyncId } : {}),
      ...(def.deprecated ? { deprecation: { replacedBy: def.deprecated.replacedBy } } : {}),
      ...(replayed ? { replayed } : {}),
    };
  }

  return {
    operations: (actor) =>
      deps.registry
        .list()
        .filter((op) => callable(op, actor) && keyScopeProblem(op, actor) === undefined),

    async execute(opName, rawInput, actor, options = {}) {
      const started = performance.now();
      const correlationId = options.correlationId ?? randomUUID();
      const log = deps.log.child({ correlationId });

      // 1–2. An internal operation the actor may not call doesn't exist for them.
      const found = deps.registry.get(opName);
      const def = found && callable(found, actor) ? found : undefined;

      let outcome: ExecuteResult;
      try {
        if (!def) throw unknownOperation(opName, deps.registry, (op) => callable(op, actor));
        outcome = await run(def, rawInput, actor, options, log);
      } catch (error) {
        outcome = { ok: false, error: toOperationError(error, def?.name, correlationId) };
        if (outcome.error.code === 'INTERNAL') {
          log.error({ err: loggableError(error), op: def?.name }, 'operation failed');
        }
      }

      // 14. Log and metrics. Unknown names stay out of labels to bound cardinality.
      const durationMs = performance.now() - started;
      const opLabel = def?.name ?? 'unknown';
      const result = outcome.ok ? 'ok' : outcome.error.code;
      log.info(
        {
          op: opLabel,
          actorKind: actor.kind,
          durationMs: Math.round(durationMs * 100) / 100,
          outcome: result,
        },
        'operation',
      );
      metrics.observe(opLabel, def?.kind ?? 'unknown', result, durationMs / 1000);
      return outcome;
    },
  };
}

/** One handler per operation, each for an operation in the registry. */
function handlerMap(
  registry: OperationRegistry,
  handlers: readonly Handler[],
): ReadonlyMap<string, Handler> {
  const map = new Map<string, Handler>();
  for (const h of handlers) {
    if (registry.get(h.op.name) !== h.op) {
      throw new Error(`Handler for ${h.op.name} does not belong to an operation in the registry`);
    }
    if (map.has(h.op.name)) throw new Error(`Two handlers are registered for ${h.op.name}`);
    map.set(h.op.name, h);
  }
  return map;
}

/** Operations in the registry with no handler. Startup and tests require this to be empty. */
export function missingHandlers(
  registry: OperationRegistry,
  handlers: readonly Handler[],
): string[] {
  const handled = new Set(handlers.map((h) => h.op.name));
  return registry
    .list()
    .map((op) => op.name)
    .filter((name) => !handled.has(name));
}

function unknownOperation(
  name: string,
  registry: OperationRegistry,
  visible: (op: AnyOperation) => boolean,
): SurfaceError {
  const shown = name.length > 100 ? `${name.slice(0, 100)}…` : name;
  const names = registry
    .list()
    .filter(visible)
    .map((op) => op.name);
  const suggestions = nearestNames(name, names);
  const hint = suggestions.length > 0 ? ` Did you mean ${suggestions.join(', ')}?` : '';
  return new SurfaceError('UNKNOWN_OPERATION', `Unknown operation "${shown}".${hint}`);
}

function invalidInput(error: z.ZodError): SurfaceError {
  const issues: ErrorIssue[] = error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    message: issue.message,
  }));
  const [first] = issues;
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return new SurfaceError('INVALID_INPUT', `${where}${first?.message ?? 'Invalid input'}${more}`, {
    issues,
  });
}

const CHANGED_MEANWHILE =
  'Something this change refers to was changed or deleted meanwhile. Reload and try again.';

function toOperationError(
  error: unknown,
  operation: string | undefined,
  correlationId: string,
): OperationError {
  const op = operation !== undefined ? { operation } : {};
  if (error instanceof SurfaceError) {
    return { code: error.code, ...op, message: error.message, ...error.details, correlationId };
  }
  if (postgresCode(error) === '23503') {
    // Mutations run READ COMMITTED (SPEC-003 Q6): a row resolved at step 7 can be deleted by
    // another transaction before the handler references it. That's a race, not a bug
    // (sync-protocol §5.4), so the caller may retry.
    return { code: 'CONFLICT', ...op, message: CHANGED_MEANWHILE, correlationId };
  }
  // E3, E4: anything unexpected is a bug. Its details are logged, never returned.
  return { code: 'INTERNAL', ...op, message: INTERNAL_MESSAGE, correlationId };
}
