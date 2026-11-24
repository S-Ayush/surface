CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"file_id" uuid,
	"file_name" text,
	"mime_type" text,
	"size" bigint,
	"image_width" integer,
	"image_height" integer,
	"preview_file_id" uuid,
	"creator_id" uuid NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_kind_check" CHECK ("attachments"."kind" IN ('file', 'link')),
	CONSTRAINT "attachments_title_check" CHECK (char_length("attachments"."title") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_link_check" CHECK (("attachments"."kind" = 'link') = ("attachments"."url" IS NOT NULL)),
	CONSTRAINT "attachments_url_check" CHECK ("attachments"."url" IS NULL OR char_length("attachments"."url") <= 2048),
	CONSTRAINT "attachments_file_check" CHECK (("attachments"."kind" = 'file') = ("attachments"."file_id" IS NOT NULL)),
	CONSTRAINT "attachments_size_check" CHECK ("attachments"."size" IS NULL OR "attachments"."size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_preview_file_id_files_id_fk" FOREIGN KEY ("preview_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_issue_id_idx" ON "attachments" USING btree ("issue_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_file_id_idx" ON "attachments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "attachments_preview_file_id_idx" ON "attachments" USING btree ("preview_file_id");--> statement-breakpoint
CREATE INDEX "attachments_sync_groups_idx" ON "attachments" USING gin ("sync_groups");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;