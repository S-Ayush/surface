CREATE TABLE "client_mutations" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_results" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"sync_id" bigint PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"model_id" uuid NOT NULL,
	"action" char(1) NOT NULL,
	"data" jsonb,
	"groups" text[] NOT NULL,
	"client_id" uuid,
	"client_seq" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_log_action_check" CHECK ("sync_log"."action" IN ('I', 'U', 'A', 'V', 'D'))
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_sync_id" bigint NOT NULL,
	CONSTRAINT "sync_state_single_row" CHECK ("sync_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "debug_items" ADD COLUMN "archived_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "sync_log_groups_gin" ON "sync_log" USING gin ("groups");