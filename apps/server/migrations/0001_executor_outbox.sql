CREATE TABLE "debug_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"sync_groups" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor" jsonb NOT NULL,
	"subject" jsonb NOT NULL,
	"changes" jsonb,
	"data" jsonb,
	"last_sync_id" bigint,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "debug_items_sync_groups_idx" ON "debug_items" USING gin ("sync_groups");--> statement-breakpoint
CREATE INDEX "event_outbox_unprocessed_idx" ON "event_outbox" USING btree ("occurred_at") WHERE "event_outbox"."processed_at" IS NULL;