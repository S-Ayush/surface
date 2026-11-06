/**
 * What a handler receives (SPEC-003 §6 "Handler context"), and `handler()` to declare one.
 * Handlers write only through `ctx.repo`, emit events with `ctx.emit()`, take time from
 * `ctx.now()`, and never commit, retry or call the network.
 */
import type { Actor, ResolvedRefs } from '@surface/domain';
import type { AnyOperation, ParsedInputOf } from '@surface/operations';
import { and, arrayOverlaps, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { SYNCED_MODELS, type ModelName, type ModelRow } from '../sync/models.js';
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
  /** The row if it exists and the actor can see it; otherwise `undefined` (report `NOT_FOUND`). */
  get<M extends ModelName>(model: M, id: string): Promise<ModelRow<M> | undefined>;
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

export function queryHelpers(tx: NodePgDatabase, actor: Actor): QueryHelpers {
  return {
    async get(model, id) {
      const { table } = SYNCED_MODELS[model];
      const visible =
        actor.kind === 'system'
          ? eq(table.id, id)
          : and(eq(table.id, id), arrayOverlaps(table.syncGroups, [...actor.groups]));
      const [row] = await tx.select().from(table).where(visible).limit(1);
      return row;
    },
  };
}
