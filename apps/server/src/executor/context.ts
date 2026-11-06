/**
 * What a handler receives (SPEC-003 §6 "Handler context"), and `handler()` to declare one.
 * Handlers write only through `ctx.repo`, emit events with `ctx.emit()`, take time from
 * `ctx.now()`, and never commit, retry or call the network.
 */
import type { Actor, ResolvedRefs } from '@surface/domain';
import type { AnyOperation, ParsedInputOf } from '@surface/operations';
import type { FilterFields } from '@surface/domain';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { SYNCED_MODELS, type ModelName, type ModelRow } from '../sync/models.js';
import {
  countQuery,
  groupByQuery,
  listQuery,
  visibleTo,
  type CountArgs,
  type Group,
  type GroupByArgs,
  type ListArgs,
  type ListModel,
  type Page,
} from './list.js';
import type { Repo } from './repo.js';

/** A domain event as a handler emits it (events.md envelope, minus what the executor fills in). */
export interface DomainEvent {
  /** Event name from events.md, like `issue.updated`. */
  readonly type: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly changes?: Readonly<Record<string, { readonly from: unknown; readonly to: unknown }>>;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Read helpers that apply the actor's visibility in SQL. */
export interface QueryHelpers {
  /**
   * The row if it exists and the actor can see it (sync groups, and an API key's teams);
   * otherwise `undefined`, which the handler reports as `NOT_FOUND`.
   */
  get<M extends ModelName>(model: M, id: string): Promise<ModelRow<M> | undefined>;
  /** A page of visible rows (SPEC-003 §7.1); the input is the op's parsed `listInput`. */
  list<T extends PgTable, F extends FilterFields>(
    model: ListModel<T, F>,
    args: ListArgs,
  ): Promise<Page<T['$inferSelect']>>;
  count<T extends PgTable, F extends FilterFields>(
    model: ListModel<T, F>,
    args: CountArgs,
  ): Promise<number>;
  groupBy<T extends PgTable, F extends FilterFields>(
    model: ListModel<T, F>,
    args: GroupByArgs,
  ): Promise<Group[]>;
}

export interface HandlerContext {
  readonly actor: Actor;
  /** References resolved and visibility-checked by the executor (step 7). */
  readonly refs: ResolvedRefs;
  /** The operation's transaction, for reads. Writes to synced tables go through `repo`. */
  readonly tx: NodePgDatabase;
  readonly repo: Repo;
  readonly query: QueryHelpers;
  /** Buffers a domain event; the executor writes it to `event_outbox` before commit. */
  emit(event: DomainEvent): void;
  /** One timestamp for the whole execution. */
  now(): Date;
  readonly log: Logger;
}

export interface Handler<Op extends AnyOperation = AnyOperation> {
  readonly op: Op;
  /** Returns data shaped like `op.output`; the executor validates it before commit. */
  run(ctx: HandlerContext, input: ParsedInputOf<Op>): Promise<z.input<Op['output']>>;
}

/** Declares the server handler of an operation: `export default handler(teamUpdate, async (ctx, input) => …)`. */
export function handler<Op extends AnyOperation>(
  op: Op,
  run: (ctx: HandlerContext, input: ParsedInputOf<Op>) => Promise<z.input<Op['output']>>,
): Handler<Op> {
  return { op, run };
}

/**
 * Read helpers over the handler's transaction. `client` is the same connection, for the
 * reference resolvers that list filters use.
 */
export function queryHelpers(
  tx: NodePgDatabase,
  client: Queryable,
  actor: Actor,
  now: Date,
): QueryHelpers {
  const listContext = {
    tx,
    client,
    actor,
    // Users' time zones arrive with user settings (PLAN-001); until then "today" is UTC's.
    filterContext: { now: now.getTime(), timeZone: 'UTC', me: actor.userId ?? null },
  };
  return {
    async get(model, id) {
      const { table, teamColumn } = SYNCED_MODELS[model];
      const visible = and(eq(table.id, id), visibleTo(actor, table.syncGroups, teamColumn));
      const [row] = await tx.select().from(table).where(visible).limit(1);
      return row;
    },
    list: (model, args) => listQuery(listContext, model, args),
    count: (model, args) => countQuery(listContext, model, args),
    groupBy: (model, args) => groupByQuery(listContext, model, args),
  };
}
