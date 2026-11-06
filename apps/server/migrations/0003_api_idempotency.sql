CREATE TABLE "api_idempotency" (
	"actor_id" text NOT NULL,
	"client_mutation_id" text NOT NULL,
	"operation" text NOT NULL,
	"result" json,
	"last_sync_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_actor_id_client_mutation_id_pk" PRIMARY KEY("actor_id","client_mutation_id")
);
--> statement-breakpoint
CREATE INDEX "api_idempotency_created_at_idx" ON "api_idempotency" USING btree ("created_at");