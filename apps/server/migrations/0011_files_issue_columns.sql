CREATE TABLE "blob_release" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"released_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "detached_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "preview_of" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_preview_of_files_id_fk" FOREIGN KEY ("preview_of") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_storage_key_idx" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_issue_id_idx" ON "files" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "files_preview_of_idx" ON "files" USING btree ("preview_of");--> statement-breakpoint
CREATE INDEX "files_unclaimed_uploader_idx" ON "files" USING btree ("uploader_id") WHERE "files"."issue_id" IS NULL AND "files"."purpose" IN ('attachment', 'inline');--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_preview_of_check" CHECK (("files"."purpose" = 'preview') = ("files"."preview_of" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_detached_at_check" CHECK ("files"."detached_at" IS NULL OR "files"."purpose" = 'attachment');--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_check" CHECK ("files"."purpose" in ('avatar', 'logo', 'attachment', 'inline', 'preview'));