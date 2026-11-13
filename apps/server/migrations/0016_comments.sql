CREATE TABLE "comment_search_text" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"user_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"edited_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"resolved_at" timestamp (3) with time zone,
	"resolved_by_id" uuid,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_actor_kind_check" CHECK ("comments"."actor_kind" IN ('user', 'api', 'mcp')),
	CONSTRAINT "comments_version_check" CHECK ("comments"."version" >= 1),
	CONSTRAINT "comments_resolved_check" CHECK (("comments"."resolved_at" IS NULL) = ("comments"."resolved_by_id" IS NULL)),
	CONSTRAINT "comments_reply_resolved_check" CHECK ("comments"."parent_comment_id" IS NULL OR "comments"."resolved_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"comment_id" uuid,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_search_text" ADD CONSTRAINT "comment_search_text_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_issue_id_created_at_idx" ON "comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_comment_id_idx" ON "comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "comments_sync_groups_idx" ON "comments" USING gin ("sync_groups");--> statement-breakpoint
CREATE INDEX "reactions_comment_id_idx" ON "reactions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "reactions_issue_id_idx" ON "reactions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "reactions_sync_groups_idx" ON "reactions" USING gin ("sync_groups");