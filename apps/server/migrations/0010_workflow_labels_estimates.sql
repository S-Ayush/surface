ALTER TABLE "labels" ADD COLUMN "exclusive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "estimate_extended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "estimate_allow_zero" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "estimate_count_unestimated_as_one" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- SPEC-010 §4.1, §4.5: statuses order by fractional keys in byte order, the order of
-- `fractionalKeyBetween` (packages/domain) and of the client's comparison. Drizzle can't declare
-- a column collation, so this line is hand-written (PLAN-010 S1). No index uses `position`, and
-- a collation change on text needs no table rewrite.
ALTER TABLE "workflow_statuses" ALTER COLUMN "position" SET DATA TYPE text COLLATE "C";
