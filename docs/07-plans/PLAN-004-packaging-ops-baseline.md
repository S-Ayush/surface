# PLAN-004: Repository, CI & self-host packaging baseline

Implements: [SPEC-004](../06-specs/SPEC-004-packaging-ops-baseline.md) · Status: **Ready** · Order: **1st** (no dependencies)

---

## 1. Slices

### S1: Monorepo skeleton · M · ✅ Done 2026-11-06
> **As built:** Node 24, pnpm 10.34.9, Turborepo 2.11, TypeScript 6.0.3, ESLint 10, Vitest 5, Vite 8, React 19.
> - **No TypeScript project references.** Packages export their source under the `@surface/source` condition instead (see SPEC-004 §3), so typecheck and tests need no build.
> - **What builds to `dist/`:** `domain`, `operations`, `sync-protocol`, and `server`, the code the server runs in production. `sync-client`, `ui`, and `editor` are web-only and source-only. `editor` gets a build if the server needs it in M1.
> - **Boundary rules** are in `.dependency-cruiser.cjs`, along with rules for unresolvable imports and dependencies missing from `package.json`. They were checked with deliberate violations.
> - **Turborepo** uses a `transit` task, so the lint, typecheck and test caches are invalidated when a dependency changes.
> - **Commitlint** is configured; CI wires it to PR titles in S6.

- Root: `package.json` (`packageManager: pnpm@<pinned>`, scripts `dev`, `build`, `lint`, `typecheck`, `test`, `test:int`, `e2e`), `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc` (24), `.editorconfig`, `.gitignore`, `.gitattributes`.
- `packages/config`: `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, source export condition), ESLint flat config, Prettier config, and Vitest preset.
- Empty but buildable packages: `domain`, `operations`, `sync-protocol`, `sync-client`, `ui`, `editor`. Apps: `server` and `web` (Vite + React 19 hello page).
- **Package boundary rule:** `dependency-cruiser` config encoding architecture §3 (`domain` ← `operations` ← `sync-client` / `server`; web never imports server code).
- Changesets initialised. Conventional-commit lint runs on PR titles.
- **Done when** `pnpm i && pnpm build lint typecheck test` is green from a clean clone.

### S2: Server skeleton · M · ✅ Done 2026-11-06
> **As built:** Fastify 5.12, Zod 4, pino 10, prom-client 15. Modules in `apps/server/src/`: `config.ts`, `logger.ts`, `lifecycle.ts`, `shutdown.ts`, `app.ts` (pure factory for `inject()` tests), `server.ts` (`serve()`), `main.ts`, and `http/{health,static,metrics,errors}.ts`. 52 tests.
> - **Config:** every problem is reported in one message, cross-field rules included (DB URL or `POSTGRES_PASSWORD`; `SMTP_FROM` with `SMTP_URL`). Secret values are never echoed. Config is validated before Fastify loads: it exits in 57 ms from `dist/`, 114 ms from source (AC-6).
> - **Lifecycle:** `starting → ready → draining`, with named readiness checks (2 s timeout, details never exposed) and ordered shutdown hooks (`connections`, then `resources`). Later slices register the DB, migrations, WebSocket and job-worker hooks.
> - **Shutdown:** while draining, responses carry `Connection: close`. Without it, keep-alive sockets kept the server waiting for the full drain timeout. A second signal forces exit, and so do uncaught errors.
> - **Logs:** credentials are masked in request URLs (`?token=`, `?code=`, `/invite/<token>`), and sensitive keys are redacted up to three levels deep. Successful health probes are not logged. Request IDs come from `X-Request-Id` when it is safe, otherwise a UUID.
> - **Errors:** JSON 404 and 500 bodies follow the SPEC-003 error shape. 5xx responses return a generic message, and the details are logged.
> - **Static:** hashed `/assets/*` are immutable, and `index.html` is `no-cache`. The SPA fallback answers only HTML GETs outside the server prefixes. A missing asset returns a 404, not HTML.
> - **Dev:** `apps/server/dev.env` holds development-only values for `pnpm dev`.

- `apps/server/src/config.ts`: Zod schema for every env var in SPEC-004 §7, with fail-fast human-readable errors.
- Fastify app factory (`buildApp(config)`) with the pino logger and a redaction list, request IDs, and `TRUST_PROXY`.
- `/healthz` and `/readyz` (readiness state machine: `starting → ready → draining`).
- Graceful shutdown handler (SIGTERM/SIGINT): drain, close the WebSocket hook (a no-op until PLAN-002), close the pool, exit within 15 s.
- Static serving of `apps/web/dist` with immutable cache headers for hashed assets and `index.html` as the SPA fallback (`no-cache`).
- Optional `/metrics` (prom-client) behind `METRICS_ENABLED`.
- **Tests:** config errors (AC-6), readiness transitions (AC-9), and log redaction unit test.

### S3: Database layer & migrations · M · ✅ Done 2026-11-06
> **As built:** drizzle-orm 0.45 + drizzle-kit 0.31 on `pg` 8 (node-postgres, needed for LISTEN/NOTIFY and pg-boss). Testcontainers 12. Modules: `src/db/{pool,checks,migrate,locks}.ts`, `src/db/schema/index.ts` (empty until the first tables), `src/startup-error.ts`, `drizzle.config.ts`, `migrations/`. 83 tests (61 unit, 22 integration).
> - **Migrator:** our own runner over the drizzle-kit journal (`migrations/meta/_journal.json`), not drizzle's built-in migrator. Drizzle's runs everything in one transaction, takes no advisory lock, and can't detect a newer schema. Ours holds `pg_advisory_lock(LOCKS.migrations)`, runs one transaction per migration, and records history in `schema_migrations(idx, tag, hash, applied_at, applied_by_version)`. Startup refuses:
>   - unknown applied migrations (E7, naming the newer version);
>   - applied migrations whose SQL hash changed.
> - **Deviation:** there is no `schema_meta` table. `schema_migrations` already records what E7 needs. Migration `0000_extensions` creates `pg_trgm`, and the startup check creates it first, with instructions if that isn't permitted.
> - **Startup order:** listen → wait for the DB → **check the Postgres version → (under `LOCKS.migrations`) create extensions → migrate** → ready. `prepareDatabase(pool, { log, appVersion })` in `src/db/prepare.ts` is that sequence; the S4 `surface migrate` command should call it too. Extensions are created on the lock-holding connection, so a pool of one works. `ensureExtensions` also tolerates a concurrent `CREATE EXTENSION` from outside the lock (`23505`/`42710` → re-check). SPEC-004 §8 and §14 (D1) updated.
> - **Migrations lock:** taken with `pg_try_advisory_lock` first, logging "waiting for another instance to finish migrations" when another replica holds it. If unlocking fails, the connection is destroyed rather than returned to the pool.
> - **Rolling upgrades:** after a newer replica migrates, older replicas report 503 on `/readyz` (unknown migration). This is deliberate and documented in SPEC-004 §8 Health.
> - **Wait for DB (E1):** transient errors retry every 1 s for 60 s, with a "waiting for database…" warning at most every 5 s. Wrong credentials (`28P01`), a `pg_hba.conf` rejection (`28000`, with a `?sslmode=require` hint) or a missing database (`3D000`) fail at once. Messages include the server's reason and show host, port and database, never credentials.
> - **Readiness:** the `db` check runs `SELECT 1`, and the `migrations` check requires all applied and nothing unknown. The pool closes as a `resources` shutdown hook, and a failed startup logs one fatal message and exits 1 (tested with a child process). "Surface is ready" is logged only if no shutdown began during startup.
> - **Advisory-lock keys** live in `src/db/locks.ts`: "SURF" namespace + feature number (`migrations`, `sync`, `testDatabases`).
> - **Test harness:**
>   - `pnpm test:int` runs `vitest.int.config.js`.
>   - Global setup starts `postgres:17` via Testcontainers on the active Docker context, or uses `TEST_DATABASE_URL` (CI: a superuser URL to a service container). It then builds the migrated template `surface_test_template`.
>   - `test/db.ts` provides `createTestDatabase({ migrated })` (a clone per file), plus `withTx`, `withAdmin` and `writeMigrations` (fixture journals).
>   - The suite takes about 2.3 s warm.
> - **Not yet added:** a Drizzle query instance (`drizzle(pool)`). It arrives with the first tables (PLAN-003 S4 outbox).

- Drizzle setup in `apps/server/src/db/` (pool, `schema/` folder, `migrations/` folder, drizzle-kit config).
- `migrate()` with `pg_advisory_lock(LOCKS.migrations)`, each migration in its own transaction, and a `schema_version` check: if the DB is newer than the code, exit with the E7 message.
- Startup checks: Postgres ≥ 17, and `pg_trgm` available (create if permitted; otherwise exit with instructions, E8).
- First migration: `schema_meta`, plus extensions.
- **Test harness:** `test/db.ts` with Testcontainers Postgres 17, a per-test-file database (template DB clone for speed), and a `withTx` helper.
- **Tests:** the concurrent-migration lock (E2), newer-schema detection (E7), the PG version check.

### S4: `surface` CLI · S
- `apps/server/bin/surface.ts` (commander): `serve`, `migrate`, `version` (version, commit, schemaHash placeholder), `doctor` (config, DB, PG version, extensions, `/data` writable, disk free, SMTP connect when set). `setup-token` and `reset-password` are registered and implemented in PLAN-001.
- **Tests:** a `doctor` fixture per failure condition (AC-12).

### S5: Docker image & compose · M
- `docker/Dockerfile` per SPEC-004 §5 (deps, build, runtime). Uses `pnpm deploy --prod` for a minimal server bundle, plus `postgresql-client-17`, tini, and uid 10001.
- `docker/healthcheck.js` (GET `/healthz`).
- `docker/docker-compose.yml`, `docker-compose.external-db.yml` (no `db` service), `docker-compose.dev.yml` (Postgres only, for `pnpm dev`), `.env.example` (fully commented), `Caddyfile.example`.
- `pnpm dev` = start the dev Postgres, run migrations, then the server (tsx watch) and Vite (proxying `/api`, `/sync`, `/auth`, `/files`, and the WebSocket to the server).
- **Tests:** a local script `scripts/docker-smoke.sh` (build, compose up, wait for `/readyz`, compose down).

### S6: CI pipeline · M
- `.github/workflows/ci.yml` with stages 1–6 (SPEC-004 §4), using a pnpm store cache and the Turborepo remote cache (optional).
- **Integration** uses a Postgres 17 service container.
- **Build image:** buildx. PRs build amd64; main builds amd64 + arm64 (native arm64 runner if available, else QEMU), pushed to `ghcr.io/<org>/surface:edge`.
- **E2E skeleton:** Playwright project that runs against the compose stack built from the image (the first test checks that `/readyz` and the web shell load).
- **No-egress job (AC-10):** compose with the app on an `internal: true` network, runs the e2e suite.
- **Log secret scan (AC-11):** collect container logs after e2e, then grep for the patterns of test passwords, tokens, and cookies.
- **Image checks (AC-4/5):** run with `read_only: true` + tmpfs, assert uid 10001, assert compressed size < 250 MB.
- `.github/workflows/nightly.yml` holds a perf job placeholder, which is filled in by PLAN-002 S10.
- `.github/workflows/release.yml`: on tag `v*`, build multi-arch, push `x.y.z`, `x.y`, `latest`, and generate the GitHub release from changesets.

### S7: Install & ops docs · S
- `README.md` (15-minute install), `docs/ops/reverse-proxy.md` (Caddy, nginx, Traefik with WebSocket notes), `upgrade.md`, `backup-manual.md`, `troubleshooting.md`.

### S8: Install smoke & upgrade test · S *(finishes after PLAN-001 S2)*
- `e2e/install-smoke.spec.ts`: from a clean compose with only `.env.example` values filled in, read the setup token from `docker compose logs app`, complete setup, create a team (AC-3, scripted part).
- **Upgrade test (AC-7):** once `v0.1.0` exists, CI starts the previous release image, seeds it, swaps to the new image, then checks data and migrations. Until then the job is skipped with a TODO linked to the first release.
- **External DB test (AC-13):** compose with `docker-compose.external-db.yml` against a separate Postgres container.
- **Manual check:** the 15-minute install on a fresh Ubuntu LTS VM is recorded in the release checklist.

## 2. Modules touched
Root config, `packages/config`, `apps/server/{src/config.ts, src/app.ts, src/db/*, bin/surface.ts}`, `apps/web` (hello), `docker/*`, `.github/workflows/*`, `e2e/*`, `scripts/*`, `README.md`, `docs/ops/*`.

## 3. Migration & rollback
Only the bootstrap migration `0000_extensions` (`pg_trgm`); history lives in the runner's `schema_migrations` table (see S3 "As built"). Migrations are forward-only, and the policy is documented in `upgrade.md` (back up before upgrading).

## 4. Test plan (AC → test)

| AC | Test |
|---|---|
| AC-1 | CI job `fresh-clone` (clone, install, run the dev stack headless, curl `/readyz`) |
| AC-2 | The CI pipeline itself, plus fixture PRs violating the lint rules (kept as negative tests in `packages/config/test`) |
| AC-3 | `e2e/install-smoke.spec.ts` + the manual release checklist |
| AC-4, AC-5 | CI image-checks job |
| AC-6 | `apps/server/test/config.test.ts` |
| AC-7 | CI upgrade job (enabled after v0.1.0) |
| AC-8 | `e2e/restart.spec.ts` (sends SIGTERM to the container mid-session; extended in PLAN-002 for queued mutations) |
| AC-9 | `apps/server/test/health.test.ts` (state machine) + `apps/server/test/startup.int.test.ts` (503 while waiting for the migrations lock, then 200 with DB checks) |
| AC-10 | CI no-egress job |
| AC-11 | CI log-scan job |
| AC-12 | `apps/server/test/doctor.int.test.ts` |
| AC-13 | CI external-db job |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| arm64 builds under QEMU are slow | Native arm64 runners if available. Only build arm64 on main and tags. |
| The `pg_dump` client version mismatches the server | Pin `postgresql-client-17` and refuse backups (M7) against newer servers with a clear message |
| Testcontainers is slow in CI | Use the CI service container for integration tests, Testcontainers only locally, and template-DB cloning per file |
| The image size budget is exceeded | `pnpm deploy --prod`, no dev dependencies, slim base. A size check in CI catches regressions. |
