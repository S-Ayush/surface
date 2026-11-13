/**
 * Issue tables (PLAN-011 S3, SPEC-011 §4.10, domain-model §4.6).
 *
 * Synced (written only through `sync/repo.ts`): `issues` (eager, the `Issue` model) and the
 * content tables `issue_content` and `issue_history`, whose models PLAN-011 S5a registers. Like
 * every synced table, each holds only its model's fields plus `sync_groups` and `archived_at`.
 * Server-only: `issue_search_text`, the plain text of a description for search (SPEC-011 §4.3).
 *
 * Every foreign key from an issue table is `ON DELETE RESTRICT` (the default `NO ACTION` defers
 * nothing here, but RESTRICT says it): a status can't vanish under an issue, and purge deletes an
 * issue's content and history explicitly before the issue (SPEC-015 §4.5, ADR-0022), so no
 * cascade hides that choice. `labelIds` has no foreign key (Postgres has no array keys): the
 * handlers check them and `label.delete` keeps them clean (SPEC-011 §4.9).
 *
 * Drizzle can't declare a column collation, so one line of this slice's migration (`0013`) is
 * hand-written: `issues.sort_order` is `COLLATE "C"` (byte order, the order of the fractional
 * keys, like `workflow_statuses.position` in `0010`). Later `db:generate` runs leave it alone.
 */
import {
  HISTORY_ACTOR_KINDS,
  ISSUE_HISTORY_KINDS,
  type HistoryActorKind,
  type IssueHistoryKind,
} from '@surface/domain';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { instant, teams, users, workflowStatuses } from './workspace.js';

const audit = () => ({
  createdAt: instant().notNull().defaultNow(),
  updatedAt: instant().notNull().defaultNow(),
});
const syncGroups = () => text().array().notNull();

/** `column IN ('a', 'b')` for an enum stored as text. Values are our constants, not input. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export const issues = pgTable(
  'issues',
  {
    id: uuid().primaryKey(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /**
     * Per team, gap-free in commit order (§4.5, INV-08). Nullable only because the model is: the
     * client's overlay holds a pending issue without one. The server always sets it (CHECK).
     */
    number: integer(),
    title: text().notNull(),
    /** A status of `team_id` (INV-06): the composite key below enforces it. */
    statusId: uuid().notNull(),
    priority: integer().notNull().default(0),
    assigneeId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    labelIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    estimate: integer(),
    /** A calendar date (`YYYY-MM-DD`), no time zone. */
    dueDate: date({ mode: 'string' }),
    /** Fractional key with jitter (`order-key.ts`). `COLLATE "C"` is set by hand in `0013`. */
    sortOrder: text().notNull(),
    creatorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: instant(),
    completedAt: instant(),
    canceledAt: instant(),
    archivedAt: instant(),
    deletedAt: instant(),
    deletedById: uuid().references(() => users.id, { onDelete: 'restrict' }),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    foreignKey({
      name: 'issues_status_team_fk',
      columns: [t.statusId, t.teamId],
      // `workflow_statuses_id_team_key` (also the target of the teams' default status).
      foreignColumns: [workflowStatuses.id, workflowStatuses.teamId],
    }).onDelete('restrict'),
    // INV-08: a committed number is never reused in its team.
    uniqueIndex('issues_team_number_idx').on(t.teamId, t.number),
    // Manual order (§4.5): reads order by `(sort_order, id)` in byte order.
    index('issues_sort_order_idx').on(sql`${t.sortOrder} COLLATE "C"`, t.id),
    // The status key's RESTRICT check, and SPEC-010's "is any issue on this status?".
    index('issues_status_id_idx').on(t.statusId),
    // Beyond §4.10: `firstSortKey` reads a team's lowest key under the team's counter lock, so
    // it must not scan the team's issues (PLAN-011 S3 review).
    index('issues_team_sort_order_idx').on(t.teamId, sql`${t.sortOrder} COLLATE "C"`),
    index('issues_label_ids_idx').using('gin', t.labelIds),
    // SPEC-015 §4.9: the purge job and the Recently deleted tab read only deleted issues.
    index('issues_deleted_at_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    // `contains` filters on the title (PLAN-003 S5): case-insensitive in the ICU collation.
    index('issues_title_trgm_idx').using(
      'gin',
      sql`lower(${t.title} COLLATE "und-x-icu") gin_trgm_ops`,
    ),
    index('issues_sync_groups_idx').using('gin', t.syncGroups),
    check('issues_number_check', sql`${t.number} IS NOT NULL AND ${t.number} >= 1`),
    check('issues_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 255`),
    check('issues_priority_check', sql`${t.priority} BETWEEN 0 AND 4`),
    check('issues_label_ids_check', sql`cardinality(${t.labelIds}) <= 20`),
    check('issues_deleted_by_check', sql`${t.deletedById} IS NULL OR ${t.deletedAt} IS NOT NULL`),
  ],
);

/** One row per issue, `id` = the issue's id (SPEC-011 §4.3). A content model from PLAN-011 S5a. */
export const issueContent = pgTable(
  'issue_content',
  {
    id: uuid().primaryKey(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    /** Denormalised: always the issue's team (§5.1, D4). The repo sets it from the issue row. */
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /** Editor JSON (SPEC-013); `EMPTY_DOC` when empty, never null. */
    description: jsonb().notNull(),
    version: integer().notNull().default(1),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    index('issue_content_issue_id_idx').on(t.issueId),
    index('issue_content_sync_groups_idx').using('gin', t.syncGroups),
    check('issue_content_id_check', sql`${t.id} = ${t.issueId}`),
    check('issue_content_version_check', sql`${t.version} >= 1`),
  ],
);

/** An issue's activity (SPEC-011 §4.4). A content model from PLAN-011 S5a. */
export const issueHistory = pgTable(
  'issue_history',
  {
    id: uuid().primaryKey(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    /** Denormalised: always the issue's team (§5.1, D4). The repo sets it from the issue row. */
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    actorKind: text().$type<HistoryActorKind>().notNull(),
    /** Null for `system`; the key's owner for `api` and `mcp`. */
    actorId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    /** For `api` and `mcp`. A plain uuid: the API key table arrives in M6. */
    apiKeyId: uuid(),
    kind: text().$type<IssueHistoryKind>().notNull(),
    /** Field → `{ from, to }`, with names stored next to ids (§4.4). */
    changes: jsonb().notNull().default({}),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    index('issue_history_issue_id_created_at_idx').on(t.issueId, t.createdAt),
    index('issue_history_sync_groups_idx').using('gin', t.syncGroups),
    check('issue_history_actor_kind_check', oneOf(t.actorKind, HISTORY_ACTOR_KINDS)),
    check('issue_history_kind_check', oneOf(t.kind, ISSUE_HISTORY_KINDS)),
    check('issue_history_actor_check', sql`(${t.actorKind} = 'system') = (${t.actorId} IS NULL)`),
    check(
      'issue_history_api_key_check',
      sql`${t.apiKeyId} IS NULL OR ${t.actorKind} IN ('api', 'mcp')`,
    ),
  ],
);

/**
 * The plain text of an issue's description, for search (SPEC-011 §4.3). Server-only: written by
 * the server in the content's transaction, never synced, never computed optimistically. Purge
 * removes it with the issue.
 */
export const issueSearchText = pgTable('issue_search_text', {
  issueId: uuid()
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  descriptionText: text().notNull(),
});
