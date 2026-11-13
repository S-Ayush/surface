CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"team_id" uuid,
	"issue_id" uuid,
	"data" jsonb NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_kind_check" CHECK ("drafts"."kind" IN ('composer', 'comment')),
	CONSTRAINT "drafts_key_check" CHECK (("drafts"."kind" = 'composer' AND "drafts"."team_id" IS NOT NULL AND "drafts"."issue_id" IS NULL)
        OR ("drafts"."kind" = 'comment' AND "drafts"."issue_id" IS NOT NULL AND "drafts"."team_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_user_team_idx" ON "drafts" USING btree ("user_id","team_id") WHERE "drafts"."kind" = 'composer';--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_user_issue_idx" ON "drafts" USING btree ("user_id","issue_id") WHERE "drafts"."kind" = 'comment';--> statement-breakpoint
CREATE INDEX "drafts_sync_groups_idx" ON "drafts" USING gin ("sync_groups");