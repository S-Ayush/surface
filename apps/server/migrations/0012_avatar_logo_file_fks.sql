-- SPEC-014 §4.10, D13: the avatar and the logo name a file row, which clean-up can't delete while
-- they do. RESTRICT, never SET NULL: `users` and `workspace` are synced, and a cascade would change
-- them without a `sync_log` row (architecture rule 2). Clean-up skips a delete the key refuses.
-- Here, not in the Drizzle schema: declaring them there would make `files.ts` and `workspace.ts`
-- import each other (dependency-cruiser no-circular). No clean-up step: there are no deployed
-- rows yet, and a dev database whose ids fail the keys is recreated (D13).
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_file_id_files_id_fk"
  FOREIGN KEY ("avatar_file_id") REFERENCES "files" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_logo_file_id_files_id_fk"
  FOREIGN KEY ("logo_file_id") REFERENCES "files" ("id") ON DELETE RESTRICT;
