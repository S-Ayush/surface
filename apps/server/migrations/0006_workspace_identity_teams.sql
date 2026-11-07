CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"token_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"team_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"invited_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"accepted_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "invites_email_lowercase_check" CHECK ("invites"."email" = lower("invites"."email")),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"description" text,
	"parent_id" uuid,
	"is_group" boolean DEFAULT false NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp (3) with time zone,
	CONSTRAINT "labels_not_own_parent_check" CHECK ("labels"."parent_id" <> "labels"."id"),
	CONSTRAINT "labels_color_check" CHECK ("labels"."color" IN ('gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'violet', 'pink'))
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"token_hash" text,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_state_single_row_check" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "team_issue_counters" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"triage_responsible" boolean DEFAULT false NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memberships_team_user_key" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text DEFAULT 'gray' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"triage_enabled" boolean DEFAULT false NOT NULL,
	"default_status_id" uuid NOT NULL,
	"estimate_scale" text DEFAULT 'off' NOT NULL,
	"cycles_enabled" boolean DEFAULT false NOT NULL,
	"cycle_duration_weeks" integer DEFAULT 2 NOT NULL,
	"cycle_cooldown_weeks" integer DEFAULT 0 NOT NULL,
	"cycle_start_weekday" integer DEFAULT 1 NOT NULL,
	"cycle_upcoming_count" integer DEFAULT 2 NOT NULL,
	"cycle_auto_add_started" boolean DEFAULT false NOT NULL,
	"cycle_auto_add_completed" boolean DEFAULT false NOT NULL,
	"auto_archive_months" integer DEFAULT 6,
	"auto_close_months" integer,
	"parent_auto_complete" boolean DEFAULT false NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp (3) with time zone,
	CONSTRAINT "teams_key_format_check" CHECK ("teams"."key" ~ '^[A-Z]{2,5}$'),
	CONSTRAINT "teams_key_reserved_check" CHECK (NOT ("teams"."key" IN ('NEW', 'API', 'MCP', 'SYNC', 'AUTH'))),
	CONSTRAINT "teams_color_check" CHECK ("teams"."color" IN ('gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'violet', 'pink')),
	CONSTRAINT "teams_estimate_scale_check" CHECK ("teams"."estimate_scale" IN ('off', 'linear', 'exponential', 'fibonacci', 'tshirt')),
	CONSTRAINT "teams_cycle_duration_check" CHECK ("teams"."cycle_duration_weeks" BETWEEN 1 AND 8),
	CONSTRAINT "teams_cycle_cooldown_check" CHECK ("teams"."cycle_cooldown_weeks" BETWEEN 0 AND 2),
	CONSTRAINT "teams_cycle_start_weekday_check" CHECK ("teams"."cycle_start_weekday" BETWEEN 0 AND 6),
	CONSTRAINT "teams_cycle_upcoming_check" CHECK ("teams"."cycle_upcoming_count" BETWEEN 1 AND 15),
	CONSTRAINT "teams_auto_archive_check" CHECK ("teams"."auto_archive_months" >= 1),
	CONSTRAINT "teams_auto_close_check" CHECK ("teams"."auto_close_months" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_file_id" uuid,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase_check" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "workflow_statuses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"description" text,
	"position" text NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp (3) with time zone,
	CONSTRAINT "workflow_statuses_id_team_key" UNIQUE("id","team_id"),
	CONSTRAINT "workflow_statuses_category_check" CHECK ("workflow_statuses"."category" IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate')),
	CONSTRAINT "workflow_statuses_color_check" CHECK ("workflow_statuses"."color" IN ('gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'violet', 'pink'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo_file_id" uuid,
	"signup_policy" text DEFAULT 'invite_only' NOT NULL,
	"allowed_domain" text,
	"mcp_enabled" boolean DEFAULT true NOT NULL,
	"update_reminder" jsonb,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_signup_policy_check" CHECK ("workspace"."signup_policy" IN ('invite_only', 'domain')),
	CONSTRAINT "workspace_allowed_domain_check" CHECK ("workspace"."signup_policy" <> 'domain' OR "workspace"."allowed_domain" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_parent_id_labels_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_issue_counters" ADD CONSTRAINT "team_issue_counters_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_statuses" ADD CONSTRAINT "workflow_statuses_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_scope_parent_name_idx" ON "labels" USING btree (coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "labels_team_id_idx" ON "labels" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "labels_sync_groups_idx" ON "labels" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_tokens_token_hash_idx" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_user_id_idx" ON "magic_link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "team_memberships_user_id_idx" ON "team_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_memberships_sync_groups_idx" ON "team_memberships" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_key_idx" ON "teams" USING btree ("key");--> statement-breakpoint
CREATE INDEX "teams_sync_groups_idx" ON "teams" USING gin ("sync_groups");--> statement-breakpoint
CREATE INDEX "user_preferences_sync_groups_idx" ON "user_preferences" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_display_name_idx" ON "users" USING btree (lower("display_name"));--> statement-breakpoint
CREATE INDEX "users_sync_groups_idx" ON "users" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_statuses_team_name_idx" ON "workflow_statuses" USING btree ("team_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_statuses_team_single_category_idx" ON "workflow_statuses" USING btree ("team_id","category") WHERE "workflow_statuses"."category" IN ('triage', 'duplicate');--> statement-breakpoint
CREATE INDEX "workflow_statuses_sync_groups_idx" ON "workflow_statuses" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_singleton_idx" ON "workspace" USING btree ((true));--> statement-breakpoint
CREATE INDEX "workspace_sync_groups_idx" ON "workspace" USING gin ("sync_groups");