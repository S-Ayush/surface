-- INV-05: a team's default status is one of the team's own statuses. The pair (default status,
-- team) must exist in workflow_statuses (id, team_id), so it can't point at another team's.
-- DEFERRABLE: a team and its statuses are created in one transaction, each referring to the
-- other, so the check runs at commit. Drizzle can't express this, so it lives here.
-- The category rule (Backlog or Unstarted) is checked by handlers (workflowProblems).
ALTER TABLE "teams" ADD CONSTRAINT "teams_default_status_fk"
  FOREIGN KEY ("default_status_id", "id") REFERENCES "workflow_statuses" ("id", "team_id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- SPEC-001 §3.1: setup is pending until setup_state.completed_at is set (PLAN-001 S2).
INSERT INTO "setup_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;
