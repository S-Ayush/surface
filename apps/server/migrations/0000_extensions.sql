-- Extensions Surface relies on (ADR-0006). Startup checks create these before
-- migrating, with clear instructions when the database user lacks permission
-- (SPEC-004 E8). Kept here as well, so the schema history states the dependency.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
