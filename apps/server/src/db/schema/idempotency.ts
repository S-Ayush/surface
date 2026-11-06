import { bigint, index, json, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Results of API and MCP mutations by `clientMutationId`, kept 24 h (SPEC-003 §9). Server-only.
 * A repeat of the same id within 24 h returns the stored result without running again.
 */
export const apiIdempotency = pgTable(
  'api_idempotency',
  {
    /** `key:<api key id>` or `user:<user id>`: ids are scoped to who sent them. */
    actorId: text().notNull(),
    clientMutationId: text().notNull(),
    /** The operation the id was first used for; reusing it for another is an error. */
    operation: text().notNull(),
    /**
     * `json`, not `jsonb`: a replay returns the stored text exactly, key order included.
     * Null only inside the transaction that claimed the id, before the result is known.
     */
    result: json(),
    lastSyncId: bigint({ mode: 'number' }),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.clientMutationId] }),
    index('api_idempotency_created_at_idx').on(t.createdAt),
  ],
);
