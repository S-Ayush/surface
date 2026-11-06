-- The single sync_state row (SPEC-002 §4.1). The repo layer bumps it under LOCKS.sync;
-- sync ids start at 1.
INSERT INTO "sync_state" ("id", "last_sync_id") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;
