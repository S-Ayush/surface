CREATE TABLE "issue_content" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"description" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_content_id_check" CHECK ("issue_content"."id" = "issue_content"."issue_id"),
	CONSTRAINT "issue_content_version_check" CHECK ("issue_content"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "issue_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"api_key_id" uuid,
	"kind" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_history_actor_kind_check" CHECK ("issue_history"."actor_kind" IN ('user', 'api', 'mcp', 'system')),
	CONSTRAINT "issue_history_kind_check" CHECK ("issue_history"."kind" IN ('created', 'updated', 'deleted', 'restored', 'archived')),
	CONSTRAINT "issue_history_actor_check" CHECK (("issue_history"."actor_kind" = 'system') = ("issue_history"."actor_id" IS NULL)),
	CONSTRAINT "issue_history_api_key_check" CHECK ("issue_history"."api_key_id" IS NULL OR "issue_history"."actor_kind" IN ('api', 'mcp'))
);
--> statement-breakpoint
CREATE TABLE "issue_search_text" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"description_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"number" integer,
	"title" text NOT NULL,
	"status_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_id" uuid,
	"label_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"estimate" integer,
	"due_date" date,
	"sort_order" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"canceled_at" timestamp (3) with time zone,
	"archived_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by_id" uuid,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_number_check" CHECK ("issues"."number" IS NOT NULL AND "issues"."number" >= 1),
	CONSTRAINT "issues_title_check" CHECK (char_length("issues"."title") BETWEEN 1 AND 255),
	CONSTRAINT "issues_priority_check" CHECK ("issues"."priority" BETWEEN 0 AND 4),
	CONSTRAINT "issues_label_ids_check" CHECK (cardinality("issues"."label_ids") <= 20),
	CONSTRAINT "issues_deleted_by_check" CHECK ("issues"."deleted_by_id" IS NULL OR "issues"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "issue_content" ADD CONSTRAINT "issue_content_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_content" ADD CONSTRAINT "issue_content_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_search_text" ADD CONSTRAINT "issue_search_text_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_team_fk" FOREIGN KEY ("status_id","team_id") REFERENCES "public"."workflow_statuses"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_content_issue_id_idx" ON "issue_content" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_content_sync_groups_idx" ON "issue_content" USING gin ("sync_groups");--> statement-breakpoint
CREATE INDEX "issue_history_issue_id_created_at_idx" ON "issue_history" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_history_sync_groups_idx" ON "issue_history" USING gin ("sync_groups");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_team_number_idx" ON "issues" USING btree ("team_id","number");--> statement-breakpoint
CREATE INDEX "issues_sort_order_idx" ON "issues" USING btree ("sort_order" COLLATE "C","id");--> statement-breakpoint
CREATE INDEX "issues_status_id_idx" ON "issues" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "issues_team_sort_order_idx" ON "issues" USING btree ("team_id","sort_order" COLLATE "C");--> statement-breakpoint
CREATE INDEX "issues_label_ids_idx" ON "issues" USING gin ("label_ids");--> statement-breakpoint
CREATE INDEX "issues_title_trgm_idx" ON "issues" USING gin (lower("title" COLLATE "und-x-icu") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_sync_groups_idx" ON "issues" USING gin ("sync_groups");--> statement-breakpoint
-- SPEC-011 §4.5: issue order keys compare in byte order, the order of `keyBefore`/`keyBetween`
-- (packages/domain) and of the client's comparison, like `workflow_statuses.position` (0010).
-- Drizzle can't declare a column collation, so this line is hand-written (PLAN-011 S3). The table
-- is new and empty, so rebuilding `issues_sort_order_idx` and `issues_team_sort_order_idx` for
-- the new collation costs nothing.
ALTER TABLE "issues" ALTER COLUMN "sort_order" SET DATA TYPE text COLLATE "C";