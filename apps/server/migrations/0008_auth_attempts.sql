CREATE TABLE "auth_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"attempted_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_attempts_key_attempted_at_idx" ON "auth_attempts" USING btree ("key","attempted_at");--> statement-breakpoint
CREATE INDEX "auth_attempts_attempted_at_idx" ON "auth_attempts" USING btree ("attempted_at");