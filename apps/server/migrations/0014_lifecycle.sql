ALTER TABLE "teams" DROP CONSTRAINT "teams_auto_archive_check";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_auto_close_check";--> statement-breakpoint
-- Hand-written (PLAN-015 S1, SPEC-015 §4.9): before the tighter checks, a null or out-of-set auto-
-- archive period becomes the default 6 months, and an out-of-set auto-close period turns auto-close
-- off. No operation could set either before this release, so no row is expected to change. Not
-- logged to sync_log: this release adds Team.autoCloseStatusId, so the schema hash changes and
-- every client bootstraps again.
UPDATE "teams" SET "auto_archive_months" = 6 WHERE "auto_archive_months" IS NULL OR "auto_archive_months" NOT IN (1, 3, 6, 9, 12);--> statement-breakpoint
UPDATE "teams" SET "auto_close_months" = NULL WHERE "auto_close_months" NOT IN (1, 3, 6, 9, 12);--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "auto_archive_months" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "auto_close_status_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_auto_close_status_id_workflow_statuses_id_fk" FOREIGN KEY ("auto_close_status_id") REFERENCES "public"."workflow_statuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_deleted_at_idx" ON "issues" USING btree ("deleted_at") WHERE "issues"."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_auto_archive_check" CHECK ("teams"."auto_archive_months" IN (1, 3, 6, 9, 12));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_auto_close_check" CHECK ("teams"."auto_close_months" IS NULL OR "teams"."auto_close_months" IN (1, 3, 6, 9, 12));