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
 *
 * Sync clients (`executeSynced`, SPEC-002 §4.4) run the same steps in one read-write transaction
 * that first locks their `client_mutations` row: a seq already processed replays its stored
 * result, and a rejected mutation rolls back to a savepoint and is recorded as rejected, so the
 * client's queue moves on.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import type { MutationResult } from '@surface/sync-protocol';
import {
  evaluatePermission,
  fieldsProblem,
  shapeOutput,
  type AnyOperation,
  type OperationRegistry,
} from '@surface/operations';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';
import type { z } from 'zod';
import { deleteUserSessions } from '../auth/store.js';
import type { Pool } from '../db/pool.js';
import { eventOutbox } from '../db/schema/index.js';
import { uuidv7 } from '../db/uuidv7.js';
import { queryHelpers, type DomainEvent, type Handler, type HandlerContext } from './context.js';
import { INTERNAL_MESSAGE, SurfaceError, type ErrorIssue, type OperationError } from './errors.js';
import { checkClientMutationId, claim, idempotencyOwner, record } from './idempotency.js';
import { keyScopeProblem, narrowToKeyTeams, refOutsideKeyTeams } from './key-scope.js';
import { loggableError } from './log-error.js';
import { audit, type AuditLine } from '../auth/audit.js';
import {
  noMetrics,
  noSyncMetrics,
  operationMetrics,
  syncMetrics,
  type OperationMetrics,
  type SyncMetrics,
} from './metrics.js';
import { unlimited, type RateLimiter } from './rate-limit.js';
import { refNotFound, refPlan, resolveRefs, single, valueAt } from './refs/resolve.js';
import { claimSeq, recordResult, visibleHead } from '../sync/client-mutations.js';
import { serverSyncRegistry } from '../sync/registry.js';
import { syncRepo, type RepoFactory, type RowChange, type TransactionRepo } from '../sync/repo.js';
import { nearestNames } from './suggest.js';
import { inTransaction, isRetryable, jitterBackoff, postgresCode } from './transaction.js';
import { NO_EMAIL, type EmailOutbox } from '../jobs/email.js';
import { handlerLinks } from '../mail/link-tokens.js';

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
  /** Where `ctx.enqueueEmail` queues email. Default: no SMTP, nothing is queued. */
  readonly email?: EmailOutbox;
  /**
   * Closes the sockets of sessions an operation ended, on every replica (`sessionCloser`).
   * Called only after the commit that deleted them.
   */
  readonly closeSessions?: (sessionIds: readonly string[]) => void;
  /**
   * The models this server's sync connections receive (`SyncRegistry.models`), for confirming a
   * synced mutation that changed nothing (`visibleHead`). Default: the production models.
   */
  readonly syncedModels?: readonly string[];
  /** `SURFACE_URL`, for the links handlers issue (`ctx.links`). Without it, issuing one fails. */
  readonly publicUrl?: string;
}

interface TransactionOutcome {
  readonly result: unknown;
  readonly lastSyncId: number | undefined;
  readonly replayed?: true;
  /** When the sync lock was taken, if it was: it is held until the commit. */
  readonly lockedAt?: number;
  /** Sessions the handler ended, whose sockets close once this commits. */
  readonly endedSessions?: readonly string[];
  /** Audit lines the handler recorded, written once this commits. */
  readonly audits?: readonly AuditLine[];
}

/** Where a sync client's mutation comes from (SPEC-002 §4.4); `seq` is per `clientId`. */
export interface SyncOrigin {
  readonly clientId: string;
  readonly seq: number;
}

export type SyncedOutcome =
  /** The mutation's result, also when it was rejected; `replayed` when it was stored before. */
  | { readonly kind: 'result'; readonly result: MutationResult; readonly replayed?: true }
  /** The seq is past the last one processed plus one: the client resends from `lastSeq + 1`. */
  | { readonly kind: 'gap'; readonly lastSeq: number }
  /** Nothing was recorded, and the request fails as a whole (rate limit, a foreign client, a fault). */
  | { readonly kind: 'refused'; readonly error: OperationError };

export interface ExecuteOptions {
  /** Ties the result, the log line and any error together; the HTTP request id when there is one. */
  readonly correlationId?: string;
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
  /**
   * One mutation from a sync client, exactly once per `(clientId, seq)` (SPEC-002 §4.4). Rejected
   * mutations are recorded as such and returned as results, not as `refused`.
   */
  executeSynced(
    opName: string,
    rawInput: unknown,
    actor: Actor,
    origin: SyncOrigin,
    options?: Pick<ExecuteOptions, 'correlationId'>,
  ): Promise<SyncedOutcome>;
}

/** Steps 3–5 passed: what the transaction runs. */
interface Prepared {
  readonly input: unknown;
  readonly handler: Handler;
  readonly viewer: Actor;
}

/** Steps 7–11 done, inside the transaction. */
interface Applied {
  readonly output: unknown;
  readonly lastSyncId: number | undefined;
  readonly lockedAt?: number;
  readonly endedSessions?: readonly string[];
  readonly audits?: readonly AuditLine[];
}

/** What waits for the commit, carried from `apply` to `afterCommit`. */
function postCommit(applied: Applied): Pick<Applied, 'lockedAt' | 'endedSessions' | 'audits'> {
  return {
    ...(applied.lockedAt === undefined ? {} : { lockedAt: applied.lockedAt }),
    ...(applied.endedSessions === undefined ? {} : { endedSessions: applied.endedSessions }),
    ...(applied.audits === undefined ? {} : { audits: applied.audits }),
  };
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const handlers = handlerMap(deps.registry, deps.handlers);
  const metrics: OperationMetrics = deps.metrics ? operationMetrics(deps.metrics) : noMetrics;
  const syncLock: SyncMetrics = deps.metrics ? syncMetrics(deps.metrics) : noSyncMetrics;
  const rateLimiter = deps.rateLimiter ?? unlimited;
  const repoFactory = deps.repoFactory ?? syncRepo;
  const checks = deps.checks ?? [];
  const clock = deps.clock ?? (() => new Date());
  const email = deps.email ?? NO_EMAIL;
  const transactionOptions = { retries: deps.retries ?? 3, backoff: deps.backoff ?? jitterBackoff };
  let defaultModels: readonly string[] | undefined;
  const syncedModels = (): readonly string[] =>
    deps.syncedModels ??
    (defaultModels ??= serverSyncRegistry({}).models.map((model) => model.name));

  const callable = (def: AnyOperation, actor: Actor) =>
    !def.internal || (deps.allowInternal && actor.kind === 'user');

  /** Steps 3–5: nothing here touches the database. `beforeInput` is step 4, the rate limit. */
  function prepare(
    def: AnyOperation,
    rawInput: unknown,
    actor: Actor,
    fields: readonly string[] | undefined,
    beforeInput: () => void,
  ): Prepared {
    // 3. Key scope
    const scopeProblem = keyScopeProblem(def, actor);
    if (scopeProblem) throw new SurfaceError('FORBIDDEN', scopeProblem);

    // 4. Rate limit
    beforeInput();

    // 5. Input
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) throw invalidInput(parsed.error);
    if (fields !== undefined) {
      const problem = fieldsProblem(def, fields);
      if (problem) {
        throw new SurfaceError('INVALID_INPUT', problem.message, {
          issues: [{ path: ['fields', problem.index], message: problem.message }],
        });
      }
    }

    const handler = handlers.get(def.name);
    if (!handler) throw new Error(`No handler is registered for ${def.name}`);
    return { input: parsed.data, handler, viewer: narrowToKeyTeams(actor) };
  }

  /** Step 4. */
  function takeRate(def: AnyOperation, actor: Actor): void {
    const rate = rateLimiter.take(actor, def.kind);
    if (!rate.allowed) {
      throw new SurfaceError(
        'RATE_LIMITED',
        `Too many requests. Try again in ${rate.retryAfterSeconds} s.`,
        { retryAfter: rate.retryAfterSeconds },
      );
    }
  }

  /** Steps 7–11, in the caller's transaction. */
  async function apply(
    client: PoolClient,
    def: AnyOperation,
    { input, handler, viewer }: Prepared,
    actor: Actor,
    origin: { readonly clientId?: string; readonly seq?: number },
    log: Logger,
  ): Promise<Applied> {
    const now = clock();
    const tx = drizzle({ client, casing: 'snake_case' });
    const repo = repoFactory(tx, now);
    const events: DomainEvent[] = [];
    // Per attempt: a retried transaction starts again from nothing.
    const ended: string[] = [];
    const audits: AuditLine[] = [];

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
      audit: (event, fields, message) => void audits.push({ event, fields, message }),
      now: () => new Date(now),
      log,
      enqueueEmail: (job) => email.enqueue(client, job),
      closeSessions: async (userId, which) => {
        const ids = await deleteUserSessions(client, userId, which);
        ended.push(...ids);
        return ids.length;
      },
      links: handlerLinks(client, deps.publicUrl, now),
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
      return {
        output: output.data,
        lastSyncId: undefined,
        ...(audits.length > 0 ? { audits } : {}),
      };
    }
    const flushed = await repo.flush({
      ...(origin.clientId !== undefined ? { clientId: origin.clientId } : {}),
      ...(origin.seq !== undefined ? { seq: origin.seq } : {}),
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
    return {
      output: output.data,
      lastSyncId: flushed.lastSyncId,
      ...(flushed.lockedAt === undefined ? {} : { lockedAt: flushed.lockedAt }),
      ...(ended.length > 0 ? { endedSessions: ended } : {}),
      ...(audits.length > 0 ? { audits } : {}),
    };
  }

  /**
   * After the commit: the lock metric, the sockets of sessions the operation ended, and its audit
   * lines. The operation is committed by now, so nothing here may fail it.
   */
  function afterCommit(
    committed: Pick<Applied, 'lockedAt' | 'endedSessions' | 'audits'>,
    opName: string,
    log: Logger,
  ): void {
    if (committed.lockedAt !== undefined) {
      syncLock.observeLockHold((performance.now() - committed.lockedAt) / 1000);
    }
    // A socket closed earlier could reconnect while the session still existed. The operation is
    // committed by now, so a failure here is logged, never returned.
    if (committed.endedSessions !== undefined && deps.closeSessions) {
      try {
        deps.closeSessions(committed.endedSessions);
      } catch (error) {
        log.error({ err: loggableError(error), op: opName }, 'could not close ended sessions');
      }
    }
    try {
      for (const line of committed.audits ?? []) audit(log, line.event, line.fields, line.message);
    } catch (error) {
      log.error({ err: loggableError(error), op: opName }, 'could not write audit lines');
    }
  }

  async function run(
    def: AnyOperation,
    rawInput: unknown,
    actor: Actor,
    options: ExecuteOptions,
    log: Logger,
  ): Promise<ExecuteResult> {
    const fields = options.fields;
    const prepared = prepare(def, rawInput, actor, fields, () => takeRate(def, actor));

    const owner = def.kind === 'mutation' ? idempotencyOwner(actor) : undefined;
    const clientMutationId = owner === undefined ? undefined : options.clientMutationId;
    if (clientMutationId !== undefined) checkClientMutationId(clientMutationId);

    // 6–12
    const outcome = await inTransaction(
      deps.pool,
      { ...transactionOptions, readOnly: def.kind === 'query' },
      async (client): Promise<TransactionOutcome> => {
        // 6. Idempotency, before anything is read: a replay doesn't look at the present.
        const tx = drizzle({ client, casing: 'snake_case' });
        if (owner !== undefined && clientMutationId !== undefined) {
          const claimed = await claim(tx, owner, clientMutationId, def.name);
          if ('replay' in claimed) return { ...claimed.replay, replayed: true };
        }
        const applied = await apply(client, def, prepared, actor, {}, log);
        if (owner !== undefined && clientMutationId !== undefined) {
          await record(tx, owner, clientMutationId, applied.output, applied.lastSyncId);
        }
        return { result: applied.output, lastSyncId: applied.lastSyncId, ...postCommit(applied) };
      },
    );
    afterCommit(outcome, def.name, log);

    // 13. Result
    const { result, lastSyncId, replayed } = outcome;
    return {
      ok: true,
      result: fields === undefined ? result : shapeOutput(def, result, fields),
      ...(lastSyncId !== undefined ? { lastSyncId } : {}),
      ...(def.deprecated ? { deprecation: { replacedBy: def.deprecated.replacedBy } } : {}),
      ...(replayed ? { replayed } : {}),
    };
  }

  /**
   * SPEC-002 §4.4. The whole mutation, lookup and validation included, runs after the client's
   * row is locked: a replay must win over anything that could fail now, and a mutation that can
   * never succeed (an unknown operation, invalid input) is recorded as rejected like any other.
   */
  async function runSynced(
    def: AnyOperation | undefined,
    opName: string,
    rawInput: unknown,
    actor: Actor,
    origin: SyncOrigin,
    correlationId: string,
    log: Logger,
  ): Promise<SyncedOutcome> {
    const userId = actor.userId;
    if (actor.kind !== 'user' || userId === undefined) {
      throw new SurfaceError('FORBIDDEN', 'Sync is for signed-in users. Use the operations API.');
    }
    const { clientId, seq } = origin;
    // A retried transaction doesn't take a second token.
    let rated = false;
    const done = await inTransaction(
      deps.pool,
      { ...transactionOptions, readOnly: false },
      async (client): Promise<SyncedTransaction> => {
        const claimed = await claimSeq(client, { clientId, userId, seq }, log);
        switch (claimed.kind) {
          case 'foreign':
            throw new SurfaceError(
              'FORBIDDEN',
              'This clientId belongs to another user. Start a new queue with a new clientId.',
            );
          case 'gap':
            return { outcome: claimed };
          case 'replay':
            return { outcome: { kind: 'result', result: claimed.result, replayed: true } };
          case 'next':
            break;
        }

        await client.query('SAVEPOINT mutation');
        let applied: Applied;
        try {
          if (!def) throw unknownOperation(opName, deps.registry, (op) => callable(op, actor));
          if (def.kind !== 'mutation') {
            throw new SurfaceError(
              'INVALID_INPUT',
              `${def.name} is a query. Sync sends mutations only; run queries through the operations API.`,
            );
          }
          const prepared = prepare(def, rawInput, actor, undefined, () => {
            if (rated) return;
            takeRate(def, actor);
            rated = true;
          });
          applied = await apply(client, def, prepared, actor, origin, log);
        } catch (error) {
          if (!recordable(error)) throw error;
          // The client row stays locked: only the mutation's own work is undone.
          await client.query('ROLLBACK TO SAVEPOINT mutation');
          const { code, message } = toOperationError(error, def?.name, correlationId);
          if (code === 'INTERNAL') {
            log.error({ err: loggableError(error), op: def?.name }, 'operation failed');
          }
          const rejected: MutationResult = { seq, status: 'error', error: { code, message } };
          await recordResult(client, clientId, rejected);
          return { outcome: { kind: 'result', result: rejected } };
        }
        const lastSyncId =
          applied.lastSyncId ??
          (await visibleHead(client, { groups: actor.groups, models: syncedModels() }));
        const ok: MutationResult = { seq, status: 'ok', lastSyncId };
        await recordResult(client, clientId, ok);
        return { outcome: { kind: 'result', result: ok }, ...postCommit(applied) };
      },
    );
    afterCommit(done, opName, log);
    return done.outcome;
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

      observe(def, actor, outcome.ok ? 'ok' : outcome.error.code, started, log);
      return outcome;
    },

    async executeSynced(opName, rawInput, actor, origin, options = {}) {
      const started = performance.now();
      const correlationId = options.correlationId ?? randomUUID();
      const log = deps.log.child({ correlationId, clientId: origin.clientId, seq: origin.seq });
      const found = deps.registry.get(opName);
      const def = found && callable(found, actor) ? found : undefined;

      let outcome: SyncedOutcome;
      try {
        outcome = await runSynced(def, opName, rawInput, actor, origin, correlationId, log);
      } catch (error) {
        // Nothing was recorded: the client sends the batch again.
        const refused = toOperationError(error, def?.name, correlationId);
        if (refused.code === 'INTERNAL') {
          log.error({ err: loggableError(error), op: def?.name }, 'operation failed');
        }
        outcome = { kind: 'refused', error: refused };
      }
      observe(def, actor, syncedLabel(outcome), started, log);
      return outcome;
    },
  };

  /** 14. Log and metrics. Unknown names stay out of labels to bound cardinality. */
  function observe(
    def: AnyOperation | undefined,
    actor: Actor,
    result: string,
    started: number,
    log: Logger,
  ): void {
    const durationMs = performance.now() - started;
    const opLabel = def?.name ?? 'unknown';
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
  }
}

interface SyncedTransaction {
  readonly outcome: SyncedOutcome;
  readonly lockedAt?: number;
  readonly endedSessions?: readonly string[];
  readonly audits?: readonly AuditLine[];
}

function syncedLabel(outcome: SyncedOutcome): string {
  switch (outcome.kind) {
    case 'result':
      return outcome.result.status === 'ok' ? 'ok' : outcome.result.error.code;
    case 'gap':
      return 'SEQ_GAP';
    case 'refused':
      return outcome.error.code;
  }
}

/**
 * Whether a sync mutation's failure is its result, recorded so the client's queue moves on. Not
 * recorded, so the batch is sent again: a rate limit (the request is refused as a whole), a
 * serialization failure or deadlock (the transaction reruns), and faults of the connection or the
 * server (SQLSTATE classes 08, 53, 57, and 55P03 lock timeouts), which a later attempt can pass.
 */
function recordable(error: unknown): boolean {
  if (error instanceof SurfaceError) return error.code !== 'RATE_LIMITED';
  if (isRetryable(error)) return false;
  const code = postgresCode(error);
  return code === undefined || !(/^(08|53|57)/.test(code) || code === '55P03');
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
