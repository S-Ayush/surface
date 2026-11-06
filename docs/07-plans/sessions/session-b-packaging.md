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
| A | `apps/server/test/startup.int.test.ts` (AC-9 lock test): the `until(...)` query counts **any** ungranted advisory lock in the cluster. Restrict it to this database: add `AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`. | Flaky (~1 in 7 runs of `pnpm test:int`): another file's worker waiting on `LOCKS.testDatabases` in `postgres` satisfies the condition before the server waits, so the "waiting for another instance" log assertion fails. More parallel int files (S4 adds two) make it likelier. Blocks a reliable CI `test:int` (S6). | done: fixed by A in `c895d62` |
| A | `TRUST_PROXY=true` is passed to Fastify as `trustProxy: true` (`apps/server/src/app.ts:36`), which trusts **every** hop: `request.ip` becomes the left-most `X-Forwarded-For` entry, which the client controls. Proposal: map `true` to `trustProxy: 1` (the one reverse proxy in front), update SPEC-004 §7, and add a test that a client-sent `X-Forwarded-For` behind one proxy does not set `request.ip`. | Once PLAN-001 lands, per-IP sign-in limits (ADR-0007) could be bypassed by rotating the header through any proxy that appends. The S7 docs work around it (nginx replaces the header; no-proxy installs set `TRUST_PROXY=false`). Not blocking M0. | open |
| PLAN-001 S2 (phase 2) | When the setup token is logged, update `README.md` step 6 ("Open Surface") with the real log line and setup URL, and drop the "until then the app shows an empty shell" status note. | README describes setup as upcoming. Not blocking. | open |

## End-of-phase handoff (2026-11-06)

Session B's phase-1 scope is done and on `main` (`245f757`), apart from the work the user deferred until the app is up (SPEC-004 §14 D4). Whoever picks up packaging, CLI or CI next starts here.

### What is on `main`

| Area | Where | Notes |
|---|---|---|
| `surface` CLI | `apps/server/src/cli/`, `apps/server/bin/surface.js` | `serve`, `migrate`, `version`, `doctor` (10 checks, read-only). `setup-token` and `reset-password` are stubs that exit 1. |
| Image and compose | `docker/` | About 102 MB compressed (arm64), uid 10001, read-only root OK. Compose: bundled DB, external DB, dev, optional Caddy. |
| Dev loop | `scripts/dev.mjs`, `apps/web/vite.config.ts` | `pnpm dev`: one dev DB per checkout (`surface-dev-<folder>`), Vite proxy to the server. |
| CI | `.github/workflows/ci.yml` | Minimal: static, unit, build, PR title, amd64 image (not pushed). **Never run on GitHub**: the repository has no remote yet. |
| Ops docs | `README.md`, `docs/ops/` | Install, reverse proxy, upgrade, backup and restore, troubleshooting. Commands verified against a real stack. |
| Smoke script | `scripts/docker-smoke.sh` | Local only. `SURFACE_SMOKE_READ_ONLY=1` covers AC-4; `SKIP_BUILD=1` reuses the image. |

### Deferred work, in the order it unblocks

1. **CI stage 3, integration:** `pnpm test:int` with a Postgres 17 service container. `vitest.int.config.js` already uses `TEST_DATABASE_URL` when it is set. A's flaky test is fixed (`c895d62`), so this is ready to build now.
2. **CI image checks (AC-4) and multi-arch push (AC-5):** reuse `docker-smoke.sh` with `SURFACE_SMOKE_READ_ONLY=1`, add the 250 MB compressed-size check, build arm64 on main only, and push `ghcr.io/s-ayush/surface:edge`. Needs the GitHub remote and a GHCR token.
3. **`release.yml`:** on tag `v*`, push `x.y.z`, `x.y` and `latest`. Set the `SURFACE_VERSION` build argument from `apps/server/package.json`, so the OCI label matches `surface version`. After the first release:
   - drop README step 2 (building from source);
   - drop the "Builds from source" section of `docs/ops/upgrade.md`;
   - remove "until the first release" from SPEC-004 §11.
4. **E2E harness:** `e2e/` doesn't exist yet. Playwright against the compose stack built from the image. The no-egress job (AC-10, `internal: true` network) and the log-scan job (AC-11) run this suite.
5. **PLAN-004 S8, after PLAN-001 S2:**
   - install smoke (AC-3, reads the setup token from the logs);
   - restart e2e (AC-8);
   - external DB (AC-13, `docker-compose.external-db.yml` against a separate Postgres);
   - upgrade test (AC-7, once `v0.1.0` exists).
6. **`nightly.yml`:** the perf job, filled in by PLAN-002 S10.

### What later work must know

- **PLAN-001:**
  - replace the two CLI stubs in `cli/run.ts` (SPEC-004 §9);
  - log the setup token;
  - do the README step 6 handoff above.
- **New configuration variable:** besides `config.ts` and its tests (CLAUDE.md rule 7), document it in `docker/.env.example` and the SPEC-004 §7 table. Add a troubleshooting entry if its error is user-facing.
- **New required extension or collation:** add it to `REQUIRED_EXTENSIONS` / `REQUIRED_COLLATIONS` in `src/db/checks.ts`. Doctor picks it up automatically and words it like startup.
- **New migrations need nothing from B:** doctor and the CLI tests don't hardcode the list.
- **Not built yet, and the docs don't claim them:**
  - E3's server warning on a mismatched `Origin`;
  - E4's "Live updates unavailable" (no `/sync` route yet, so the proxy WebSocket guidance is unverified);
  - E5's startup check on `/data` (lands with uploads, M2).
- **Native dependencies (argon2 in PLAN-001):** every Dockerfile stage runs on the target platform, so binaries match. If arm64 under QEMU is too slow in CI, compile on `$BUILDPLATFORM` and run only `pnpm deploy` per target.
- **`TRUST_PROXY`:** until A's change lands, `true` trusts every hop. The docs compensate (nginx replaces `X-Forwarded-For`; installs without a proxy set it to `false`).

### Not verified anywhere yet

- CI on GitHub;
- the README clone URL;
- the amd64 image (only arm64 was built locally);
- a cold, uncached build;
- WebSockets through a proxy;
- real TLS certificates;
- tag-based upgrades;
- the cron line with `logger`;
- the `\password` fix;
- a full 15-minute install on a fresh Ubuntu VM.

### Local leftovers (the user's to remove; deleting them was not permitted from this session)

- **Docker volumes:**
  - `surface-dev_pgdata` (stale, from the first `pnpm dev` run);
  - `surface-s7_pgdata`, `surface-s7_uploads`, `surface-s7_backups` (S7 verification stack);
  - `surface-dev-surface-b_pgdata` (this worktree's dev DB; keep it while the worktree exists).
- **Images:**
  - `surface:local`, `nginx:1.27` and `caddy:2` (S7 checks);
  - `rhysd/actionlint:latest` (S6).
- **Branches:** `p004-s4-cli`, `p004-s4b-doctor-collations`, `p004-s5-docker`, `p004-s6-ci` and `p004-s7-docs` are merged. Delete them with `git branch -d`, and remove the worktree at the phase-1 sync point (sessions README §6).

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-004 S4 | p004-s4-cli | built, in review | `surface` CLI: serve, migrate, version, doctor + PLAN-001 stubs. 106 unit / 51 int green. **Shared-file changes:** `apps/server/src/config.ts` + `test/config.test.ts` (new `DATA_DIR`, approved by the user), `apps/server/package.json` (`bin`, `surface` script; no new deps). SPEC-004 §7, §9, §14 D2 updated. Handoff from A (CI `test:int`) is planned for S6. Found a flaky A test (`startup.int.test.ts`); handoff to A raised. |
| 2026-11-06 | PLAN-004 S4 | p004-s4-cli | review fixes, ready to commit | All 7 review findings and the nits fixed: migration-independent tests, SMTP socket destroyed after QUIT (process-level test, fails without the fix), redirects reported not followed, ENOTDIR/EACCES verdicts, one entry per check on unexpected errors, scrub before formatting (12+ chars), startup/doctor message parity tests, `-V` + command is a usage error, SPEC E5 note, E2/E4 scope stated. **Shared-file change:** `apps/server/dev.env` gets `DATA_DIR=../../data` (dev only). 108 unit / 57 int green (except the known flaky A test `startup.int.test.ts`, handoff open). |
| 2026-11-06 | PLAN-004 S5 | p004-s5-docker (stacked on p004-s4-cli, which is not on main yet) | built, in review | Image ~102 MB compressed, uid 10001, read-only root OK; compose smoke + `pnpm dev` verified. **Shared-file changes:** `apps/web/vite.config.ts` (dev proxy and ports, approved by the user), root `package.json` scripts (`dev` → `scripts/dev.mjs`, `dev:db:down`, `db:migrate`, `docker:smoke`), `apps/server/package.json` (`files`). SPEC-004 §3, §6, §14 D3 updated. |
| 2026-11-06 | PLAN-004 S5 | p004-s5-docker | review fixes, ready to commit | Both majors fixed (`stop_grace_period: 20s`; dev DB per checkout: compose project `surface-dev-<folder>`), plus minors and nits: one source for `POSTGRES_PASSWORD`, `$$` wording, healthcheck exception recorded and trimming like `loadConfig()`, PGDG key fingerprint check, spec §3/§5/§6 aligned, segment-matching Vite proxy, graceful Ctrl-C. A stale `surface-dev_pgdata` volume from my first `pnpm dev` run is unused; deleting it was not permitted, so the user can remove it. |
| 2026-11-06 | PLAN-004 S4 + S5 | main | merged | Rebased onto main (`7f7b840`, A's PLAN-003 S1–S4 and E's filter core). One conflict in `apps/server/package.json` scripts, kept both. Gate green; `test:int` 119 + 2 perf green on 3 of 4 runs (the 1 failure is A's known flaky `startup.int.test.ts`); smoke test green. main fast-forwarded to `bd1a4cd`. |
| 2026-11-06 | PLAN-004 S6 | p004-s6-ci | built, in review | Minimal CI by user decision (SPEC-004 §14 D4): `ci.yml` with static + unit + build, PR-title commitlint and an amd64 image build. Integration, e2e, smoke, no-egress/log-scan/image checks, multi-arch, nightly/release and all of S8 deferred until the app is up. **Reply to A's handoff** (`pnpm test:int` in CI): deferred by the user. |
| 2026-11-06 | PLAN-004 S7 | p004-s7-docs | built, in review | README (15-minute install, image built from the clone until the first release) and `docs/ops/` reverse-proxy, upgrade, backup-manual and troubleshooting. Commands verified against a real stack (see PLAN-004 S7 As built). Branched from `p004-s6-ci`, which is not merged yet. |
| 2026-11-06 | PLAN-004 S7 | p004-s7-docs | review fixes, ready to commit | Both majors fixed: the client-address spoofing in the nginx and no-proxy examples, and the cron backup that could prune good backups after silent failures (now `backup.sh`). Minors and nits fixed; `COMPOSE_FILE` for your own database. Two Handoffs: `trustProxy` to A, README step 6 to PLAN-001 S2. |
| 2026-11-06 | PLAN-004 S6 + S7 | main | merged | Rebased onto main (`c895d62`, A's flake fixes), clean. `pnpm check` and `pnpm test:int` (158 tests) green, then main fast-forwarded to `31e040f`. B→A flake handoff closed (fixed in `c895d62`). |
| 2026-11-06 | PLAN-004 S4 follow-up | p004-s4b-doctor-collations | built, in review | A's handoff: doctor **Collations** check (`und-x-icu`), reusing startup's `checkCollations()` so the wording is the same; SPEC-004 §9 row and E8, troubleshooting and README updated. |
| 2026-11-06 | PLAN-004 S4 follow-up | p004-s4b-doctor-collations | review fixes, ready to commit | Major fixed: a failing collations check now runs through `runDoctor` and `doctorCommand` (new `DoctorOptions.collations`), and those tests fail if the wiring ignores the probe. Unit test split; AC-12 test-plan row, SPEC-004 §9 `migrate` row and a troubleshooting wrap fixed. |
| 2026-11-06 | PLAN-004 S4 follow-up | main | merged | Rebased onto main (`57bcae8`, PLAN-005 S1–S3 and PLAN-003 S7), clean. `pnpm check` and `pnpm test:int` (162 tests) green, then main fast-forwarded. Session A closes its collations handoff row in its own file. |
| 2026-11-06 | End of phase 1 | p004-handoff | written | End-of-phase handoff section added above the Log: what is on main, deferred work in unblock order, notes for later work, what is unverified, and local leftovers. |
