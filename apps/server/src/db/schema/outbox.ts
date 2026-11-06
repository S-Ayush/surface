import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Domain events, written in the operation's transaction (SPEC-003 §6 step 11, events.md).
 * Server-only. Consumers (pg-boss jobs) set `processed_at`; pruned 7 days after processing.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    /** UUIDv7, so ids sort by time. */
    id: uuid().primaryKey(),
    /** Event name from events.md, like `issue.updated`. A public contract (webhooks). */
    type: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    /** `{ kind, userId? }` of the operation's actor. */
    actor: jsonb().notNull(),
    /** `{ type, id }` of the entity the event is about. */
    subject: jsonb().notNull(),
    /** `{ field: { from, to } }` for updates. */
    changes: jsonb(),
    data: jsonb(),
    /** Sync id of the transaction that emitted the event, once sync logging exists (PLAN-002 S2). */
    lastSyncId: bigint({ mode: 'number' }),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('event_outbox_unprocessed_idx')
      .on(t.occurredAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);
