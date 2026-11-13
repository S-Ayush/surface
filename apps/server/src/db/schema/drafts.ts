/**
 * Drafts (PLAN-012 S5, SPEC-012 §4.3). Synced and user-scoped: each row is in its owner's
 * `user:<id>` group only, and only `sync/repo.ts` writes it.
 *
 * No foreign key to `teams` or `issues`, on purpose: a draft must not block an issue's purge
 * (SPEC-015 §4.5), and its insert must not tell whether a team or issue exists. The CHECK keeps
 * the key right per kind; the two partial unique indexes make one draft per user and team
 * (composer) and per user and issue (comment).
 */
import { DRAFT_KINDS, type DraftKind } from '@surface/domain/model';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { instant, users } from './workspace.js';

export const drafts = pgTable(
  'drafts',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    kind: text().$type<DraftKind>().notNull(),
    teamId: uuid(),
    issueId: uuid(),
    data: jsonb().notNull(),
    syncGroups: text().array().notNull(),
    createdAt: instant().notNull().defaultNow(),
    updatedAt: instant().notNull().defaultNow(),
  },
  (t) => [
    check(
      'drafts_kind_check',
      sql`${t.kind} IN (${sql.raw(DRAFT_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check(
      'drafts_key_check',
      sql`(${t.kind} = 'composer' AND ${t.teamId} IS NOT NULL AND ${t.issueId} IS NULL)
        OR (${t.kind} = 'comment' AND ${t.issueId} IS NOT NULL AND ${t.teamId} IS NULL)`,
    ),
    uniqueIndex('drafts_user_team_idx')
      .on(t.userId, t.teamId)
      .where(sql`${t.kind} = 'composer'`),
    uniqueIndex('drafts_user_issue_idx')
      .on(t.userId, t.issueId)
      .where(sql`${t.kind} = 'comment'`),
    index('drafts_sync_groups_idx').using('gin', t.syncGroups),
  ],
);
