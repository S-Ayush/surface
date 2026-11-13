/**
 * Workspace, identity and team tables (PLAN-001 S1, SPEC-001 §4, domain-model §4.1–4.5, §4.16).
 *
 * Synced (written only through `sync/repo.ts`): `workspace`, `users`, `user_preferences`,
 * `teams`, `team_memberships`, `workflow_statuses`, `labels`. A synced table holds only fields
 * its model declares (plus `sync_groups`, `archived_at`): the repo logs whole rows to `sync_log`
 * and every write to it is a sync delta, so a secret or a counter there would be stored in the
 * log and broadcast on each change.
 * Server-only (never sent to clients): `user_credentials` (password hashes), `team_issue_counters`,
 * `sessions` (their `last_used_at` is a user's "last seen"), `invites`, `magic_link_tokens`,
 * `password_reset_tokens`, `setup_state`.
 *
 * Enums are text with CHECKs (database rules). `teams.default_status_id` references a status of
 * the same team through a DEFERRABLE foreign key added by hand in a custom migration (Drizzle
 * can't express it): a team and its statuses are created in one transaction, each pointing at
 * the other (INV-05).
 */
import {
  AUTOMATION_MONTHS,
  COLOR_HUES,
  ESTIMATE_SCALES,
  RESERVED_TEAM_KEYS,
  SIGNUP_POLICIES,
  STATUS_CATEGORIES,
  USER_ROLES,
  type ColorHue,
  type EstimateScale,
  type SignupPolicy,
  type StatusCategory,
  type UserRole,
} from '@surface/domain';
import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** Millisecond instants, like every instant (SPEC-003 §7.4, database rules). Shared by `files.ts`. */
export const instant = () => timestamp({ withTimezone: true, precision: 3 });
const audit = () => ({
  createdAt: instant().notNull().defaultNow(),
  updatedAt: instant().notNull().defaultNow(),
});
const syncGroups = () => text().array().notNull();

/** `1, 3, 6, 9, 12`: the automation periods (SPEC-015 §3.2), our constants, not input. */
const automationMonths = sql.raw(AUTOMATION_MONTHS.join(', '));

/** `column IN ('a', 'b')` for an enum stored as text. Values are our constants, not input. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

// --- Workspace -------------------------------------------------------------------------------

export const workspace = pgTable(
  'workspace',
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    logoFileId: uuid(),
    signupPolicy: text().$type<SignupPolicy>().notNull().default('invite_only'),
    allowedDomain: text(),
    mcpEnabled: boolean().notNull().default(true),
    updateReminder: jsonb(),
    defaults: jsonb().notNull().default({}),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    // INV-01: exactly one workspace. Every row has the same value, so a second one is a duplicate.
    uniqueIndex('workspace_singleton_idx').on(sql`(true)`),
    check('workspace_signup_policy_check', oneOf(t.signupPolicy, SIGNUP_POLICIES)),
    check(
      'workspace_allowed_domain_check',
      sql`${t.signupPolicy} <> 'domain' OR ${t.allowedDomain} IS NOT NULL`,
    ),
    index('workspace_sync_groups_idx').using('gin', t.syncGroups),
  ],
);

/** First-run setup (SPEC-001 §3.1). One row, seeded by migration; server-only. */
export const setupState = pgTable(
  'setup_state',
  {
    id: smallint().primaryKey().default(1),
    tokenHash: text(),
    completedAt: instant(),
    updatedAt: instant().notNull().defaultNow(),
  },
  () => [check('setup_state_single_row_check', sql`id = 1`)],
);

// --- Identity --------------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey(),
    /** Stored lowercase (INV-02). */
    email: text().notNull(),
    name: text().notNull(),
    displayName: text().notNull(),
    avatarFileId: uuid(),
    timezone: text().notNull().default('UTC'),
    role: text().$type<UserRole>().notNull().default('member'),
    active: boolean().notNull().default(true),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    // INV-02: emails are compared case-insensitively, so they are stored lowercase.
    uniqueIndex('users_email_idx').on(t.email),
    check('users_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
    // INV-02: display names are @mention handles; `@Ana` and `@ana` are the same person.
    uniqueIndex('users_display_name_idx').on(sql`lower(${t.displayName})`),
    check('users_role_check', oneOf(t.role, USER_ROLES)),
    index('users_sync_groups_idx').using('gin', t.syncGroups),
  ],
);

/** One row per user, with the user's id as its id. Synced to `user:<id>` only. */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid()
      .primaryKey()
      .references(() => users.id),
    values: jsonb().notNull().default({}),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [index('user_preferences_sync_groups_idx').using('gin', t.syncGroups)],
);

/** A user's password (argon2id). No row for a magic-link-only user. Server-only. */
export const userCredentials = pgTable('user_credentials', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text().notNull(),
  updatedAt: instant().notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie token; the token itself is never stored. */
    tokenHash: text().notNull(),
    userAgent: text(),
    ip: text(),
    createdAt: instant().notNull().defaultNow(),
    lastUsedAt: instant().notNull().defaultNow(),
    /** 30-day sliding expiry (SPEC-001 §4). */
    expiresAt: instant().notNull(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid().primaryKey(),
    /** Lowercase; null for a link that anyone may accept. */
    email: text(),
    tokenHash: text().notNull(),
    role: text().$type<UserRole>().notNull().default('member'),
    /** Teams the invitee joins on accepting (SPEC-001 §4). */
    teamIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    invitedById: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: instant().notNull().defaultNow(),
    expiresAt: instant().notNull(),
    acceptedAt: instant(),
    revokedAt: instant(),
  },
  (t) => [
    uniqueIndex('invites_token_hash_idx').on(t.tokenHash),
    check('invites_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
    check('invites_role_check', oneOf(t.role, USER_ROLES)),
  ],
);

/** Single-use sign-in links, valid 15 minutes (SPEC-001 §4). */
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    createdAt: instant().notNull().defaultNow(),
    expiresAt: instant().notNull(),
    usedAt: instant(),
  },
  (t) => [
    uniqueIndex('magic_link_tokens_token_hash_idx').on(t.tokenHash),
    index('magic_link_tokens_user_id_idx').on(t.userId),
  ],
);

/** Single-use password reset links, valid 1 hour (SPEC-001 §4). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    createdAt: instant().notNull().defaultNow(),
    expiresAt: instant().notNull(),
    usedAt: instant(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_token_hash_idx').on(t.tokenHash),
    index('password_reset_tokens_user_id_idx').on(t.userId),
  ],
);

// --- Teams -----------------------------------------------------------------------------------

export const teams = pgTable(
  'teams',
  {
    id: uuid().primaryKey(),
    key: text().notNull(),
    name: text().notNull(),
    icon: text(),
    color: text().$type<ColorHue>().notNull().default('gray'),
    timezone: text().notNull().default('UTC'),
    private: boolean().notNull().default(false),
    triageEnabled: boolean().notNull().default(false),
    /** INV-05: a status of this team (deferrable FK, custom migration). */
    defaultStatusId: uuid().notNull(),
    estimateScale: text().$type<EstimateScale>().notNull().default('off'),
    // SPEC-010 §4.3, §4.5: the estimate options.
    estimateExtended: boolean().notNull().default(false),
    estimateAllowZero: boolean().notNull().default(false),
    estimateCountUnestimatedAsOne: boolean().notNull().default(true),
    cyclesEnabled: boolean().notNull().default(false),
    cycleDurationWeeks: integer().notNull().default(2),
    cycleCooldownWeeks: integer().notNull().default(0),
    cycleStartWeekday: integer().notNull().default(1),
    cycleUpcomingCount: integer().notNull().default(2),
    cycleAutoAddStarted: boolean().notNull().default(false),
    cycleAutoAddCompleted: boolean().notNull().default(false),
    // SPEC-015 §3.2, §4.9: 1, 3, 6, 9 or 12 months; auto-archive is never off, auto-close is off
    // while null.
    autoArchiveMonths: integer().notNull().default(6),
    autoCloseMonths: integer(),
    /**
     * The Canceled status auto-close moves stale issues to (SPEC-015 §3.2), set whenever auto-close
     * is on. RESTRICT, not a cascade: `teams` is synced, so the database must never change it
     * without a `sync_log` row (rule 2); `status.delete` refuses this status first (E22).
     */
    autoCloseStatusId: uuid().references((): AnyPgColumn => workflowStatuses.id, {
      onDelete: 'restrict',
    }),
    parentAutoComplete: boolean().notNull().default(false),
    syncGroups: syncGroups(),
    ...audit(),
    archivedAt: instant(),
  },
  (t) => [
    // INV-03
    uniqueIndex('teams_key_idx').on(t.key),
    check('teams_key_format_check', sql`${t.key} ~ '^[A-Z]{2,5}$'`),
    check('teams_key_reserved_check', sql`NOT (${oneOf(t.key, RESERVED_TEAM_KEYS)})`),
    check('teams_color_check', oneOf(t.color, COLOR_HUES)),
    check('teams_estimate_scale_check', oneOf(t.estimateScale, ESTIMATE_SCALES)),
    check('teams_cycle_duration_check', sql`${t.cycleDurationWeeks} BETWEEN 1 AND 8`),
    check('teams_cycle_cooldown_check', sql`${t.cycleCooldownWeeks} BETWEEN 0 AND 2`),
    check('teams_cycle_start_weekday_check', sql`${t.cycleStartWeekday} BETWEEN 0 AND 6`),
    check('teams_cycle_upcoming_check', sql`${t.cycleUpcomingCount} BETWEEN 1 AND 15`),
    check('teams_auto_archive_check', sql`${t.autoArchiveMonths} IN (${automationMonths})`),
    check(
      'teams_auto_close_check',
      sql`${t.autoCloseMonths} IS NULL OR ${t.autoCloseMonths} IN (${automationMonths})`,
    ),
    index('teams_sync_groups_idx').using('gin', t.syncGroups),
  ],
);

/**
 * The last issue number given out per team (INV-08: never reused). Server-only, so taking a
 * number isn't a sync delta. Issue creation upserts the row (`ON CONFLICT … SET last_number =
 * last_number + 1 RETURNING`), so a new team needs none.
 */
export const teamIssueCounters = pgTable('team_issue_counters', {
  teamId: uuid()
    .primaryKey()
    .references(() => teams.id),
  lastNumber: integer().notNull().default(0),
});

export const teamMemberships = pgTable(
  'team_memberships',
  {
    id: uuid().primaryKey(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    triageResponsible: boolean().notNull().default(false),
    syncGroups: syncGroups(),
    ...audit(),
  },
  (t) => [
    unique('team_memberships_team_user_key').on(t.teamId, t.userId),
    index('team_memberships_user_id_idx').on(t.userId),
    index('team_memberships_sync_groups_idx').using('gin', t.syncGroups),
  ],
);

export const workflowStatuses = pgTable(
  'workflow_statuses',
  {
    id: uuid().primaryKey(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    name: text().notNull(),
    category: text().$type<StatusCategory>().notNull(),
    color: text().$type<ColorHue>().notNull().default('gray'),
    description: text(),
    /**
     * Fractional-index key: order within the category (domain-model §1). `COLLATE "C"` (byte
     * order, the order of `fractionalKeyBetween`, SPEC-010 §4.1) is set by hand in migration
     * 0010: Drizzle can't declare a column collation.
     */
    position: text().notNull(),
    syncGroups: syncGroups(),
    ...audit(),
    archivedAt: instant(),
  },
  (t) => [
    uniqueIndex('workflow_statuses_team_name_idx').on(t.teamId, sql`lower(${t.name})`),
    // INV-04: one Triage and one Duplicate status per team.
    uniqueIndex('workflow_statuses_team_single_category_idx')
      .on(t.teamId, t.category)
      .where(sql`${t.category} IN ('triage', 'duplicate')`),
    // Target of the teams' default-status FK, which also requires the same team (INV-05).
    unique('workflow_statuses_id_team_key').on(t.id, t.teamId),
    check('workflow_statuses_category_check', oneOf(t.category, STATUS_CATEGORIES)),
    check('workflow_statuses_color_check', oneOf(t.color, COLOR_HUES)),
    index('workflow_statuses_sync_groups_idx').using('gin', t.syncGroups),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid().primaryKey(),
    /** Null for a workspace label. */
    teamId: uuid().references(() => teams.id),
    name: text().notNull(),
    color: text().$type<ColorHue>().notNull().default('gray'),
    description: text(),
    parentId: uuid().references((): AnyPgColumn => labels.id),
    isGroup: boolean().notNull().default(false),
    /** Groups only: single-select (SPEC-010 §4.2). */
    exclusive: boolean().notNull().default(true),
    syncGroups: syncGroups(),
    ...audit(),
    archivedAt: instant(),
  },
  (t) => [
    // Unique within its scope (team or workspace) and parent, ignoring case (domain-model §4.5).
    uniqueIndex('labels_scope_parent_name_idx').on(
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
    check('labels_not_own_parent_check', sql`${t.parentId} <> ${t.id}`),
    check('labels_color_check', oneOf(t.color, COLOR_HUES)),
    index('labels_team_id_idx').on(t.teamId),
    index('labels_sync_groups_idx').using('gin', t.syncGroups),
  ],
);
