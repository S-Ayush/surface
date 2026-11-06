# Session B: Packaging, CLI & CI

Worktree: `/Users/admin/Desktop/Learning/surface-b` · First branch: `p004-s4-cli` · Guide: [README](README.md)

## Setup

```bash
cd /Users/admin/Desktop/Learning/surface
git worktree add ../surface-b -b p004-s4-cli main      # after PLAN-004 S3 is on main
cd ../surface-b && source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
claude
```

## Scope, in order

Read [PLAN-004](../PLAN-004-packaging-ops-baseline.md) and [SPEC-004](../../06-specs/SPEC-004-packaging-ops-baseline.md). The "As built" notes of S1–S3 describe the current server, which you build on.

1. **S4: `surface` CLI:** `serve`, `migrate` (call `prepareDatabase()` from `src/db/prepare.ts`, not `migrate()` alone), `version`, `doctor`. Register `setup-token` and `reset-password` as stubs that say they arrive in PLAN-001. `doctor` covers every SPEC-004 §12 condition that exists so far (AC-12).
2. **S5: Docker image and compose:** `docker/Dockerfile` (runs as uid 10001, read-only root filesystem, < 250 MB), the compose files, `.env.example`, `Caddyfile.example`, and `docker-compose.dev.yml` + `pnpm dev` (Postgres for development on port 5432, the server on 3200 in this worktree, Vite proxy).
3. **S6: CI:** `.github/workflows/{ci,nightly,release}.yml`, stages 1–6. Also add `pnpm test:int` with a Postgres 17 service container and `TEST_DATABASE_URL` (handoff from A). Build the no-egress, log-scan and image-check jobs.
4. **S7: install and ops docs:** `README.md`, plus `docs/ops/{reverse-proxy,upgrade,backup-manual,troubleshooting}.md`.
5. **S8 (partial):** the external-DB compose test (AC-13) and the restart e2e (AC-8). The install smoke test waits for PLAN-001 S2 (setup); leave it as a TODO in the log.

## Owns

- `apps/server/bin/**`, `apps/server/src/cli/**`; the `bin` field and CLI dependencies in `apps/server/package.json`
- `docker/**`, `.github/**`, `e2e/**` (harness and infrastructure tests), `scripts/**`
- `README.md`, `docs/ops/**`, `.env.example`
- The S4–S8 sections of `docs/07-plans/PLAN-004-*.md`, and SPEC-004 (where your slices change behaviour or configuration)

## Must not touch

`apps/server/src/{db,executor,sync,http}/**` (session A), `packages/**` except additive `packages/config` presets, `CLAUDE.md`, `.claude/**`.

If the CLI needs a new export from `src/db/*` or `src/server.ts`, write a handoff to A. For a tiny re-export, ask the user first.

## Prompt

```
You are session B of the Surface project, working in the git worktree /Users/admin/Desktop/Learning/surface-b. Your track is packaging, the CLI and CI: PLAN-004 slices S4–S8.
Read, in order: CLAUDE.md, docs/07-plans/sessions/README.md, docs/07-plans/sessions/session-b-packaging.md, then PLAN-004 (including the "As built" notes of S1–S3) and SPEC-004.
Check the Log and Handoffs tables in all four session files before starting.

Implement the scope in session-b-packaging.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with PLAN-004 S4 on branch p004-s4-cli.
Edit only the files listed under "Owns". Never touch the "Must not touch" areas: request changes there through the Handoffs table.
Do not generate database migrations.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-b-packaging.md;
- update PLAN-004's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
Docker runs on Colima. Use port 3200 for any server you start in this worktree.
```

## Handoffs (requests from B to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
