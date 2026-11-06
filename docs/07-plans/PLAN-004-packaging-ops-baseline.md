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

### S4: `surface` CLI · S · ✅ Done 2026-11-06
> **As built:** No new dependencies. Modules in `apps/server/src/cli/`: `main.ts` (entry), `run.ts` (parsing and dispatch), `io.ts`, `version.ts`, `migrate.ts`, and `doctor/{checks,probes,doctor}.ts`. `apps/server/bin/surface.js` is a shim over `dist/cli/main.js` (the `bin` field). In development use `pnpm --filter @surface/server surface <command>` (tsx, source, loads `dev.env`; `dev.env` sets `DATA_DIR=../../data`, the gitignored `/data/` at the repo root, which S5's `pnpm dev` should create). 47 unit + 35 integration tests.
> - **Deviation:** arguments are parsed with `node:util` `parseArgs`, not commander. Six commands and two flags don't justify a dependency in the image. Exit codes: 0 ok, 1 failed, 2 usage.
> - **Lazy loading:** `run.ts` imports only `config.ts`, and each command is a dynamic import. `surface` (= `serve`) with a bad config still exits in < 1 s (AC-6 test via `src/cli/main.ts`), and `version` needs neither config nor a database.
> - **`serve`** calls the existing `serve(config)`; `src/main.ts` stays as the `pnpm dev`/`start` entry for now. S5 points the image `ENTRYPOINT` at `bin/surface.js`.
> - **`migrate`** = `waitForDatabase` (60 s, like `serve`) → `prepareDatabase()` with a pool of 2, JSON logs to stdout ("migrations applied" / "nothing to migrate"), StartupError → one fatal line, exit 1.
> - **`version`** prints version, commit and **schema level** (the newest migration tag and count) instead of a schema-hash placeholder. The sync `schemaHash` (sync-protocol.md) belongs to PLAN-002 and is added there.
> - **`doctor`** is read-only and checks, in four concurrent groups: config → database → PostgreSQL version → extensions → migrations; data directory → disk; SMTP; public URL. Every check is a pure verdict over gathered facts (`checks.ts`), so conditions postgres:17 can't produce (PG < 17, no contrib, a full disk) have unit fixtures. The SMTP check only reads the `220` greeting and sends `QUIT`; credentials are not tested (that would need an SMTP client dependency). After `QUIT` the socket is destroyed within 1 s, so a server that never hangs up can't keep the process alive. The public-URL check is a warning only (SPEC-004 §14 D2) and does not follow redirects: a redirect is reported with its target. A probe that throws unexpectedly is reported on its own check and the rest of its group is skipped, so the report always has one entry per check. Messages are scrubbed of the session secret, setup token and DB/SMTP passwords (12+ characters; shorter ones are often ordinary words such as the dev password `surface`) before formatting. Startup and doctor wording for extensions is kept equal by a test, since doctor can't reuse `ensureExtensions()` (it creates).
> - **New config `DATA_DIR`** (default `/data`, absolute after loading), agreed with the user although `config.ts` is outside session B's list. SPEC-004 §7 and §9 updated. `.env.example` doesn't exist yet: S5 creates it with every variable, `DATA_DIR` included.
> - **Not in M0 yet:** the E5 startup check (exit when `/data` is not writable) belongs with the first code that writes there (uploads, M2+). Until then only `doctor` reports it.
> - **AC-12 scope:** doctor covers E1, E3, E5, E6, E7 and E8 (plus SMTP). E2 (concurrent replicas) is not a doctor condition: the migrations lock handles it (AC-9 tests). E4 (proxy strips WebSocket upgrades) has no WebSocket to probe until the sync hub (PLAN-002 S4); a doctor check for it can be added then.

- `apps/server/bin/surface.ts` (commander): `serve`, `migrate`, `version` (version, commit, schemaHash placeholder), `doctor` (config, DB, PG version, extensions, `/data` writable, disk free, SMTP connect when set). `setup-token` and `reset-password` are registered and implemented in PLAN-001.
- **Tests:** a `doctor` fixture per failure condition (AC-12).

### S5: Docker image & compose · M · ✅ Done 2026-11-06
> **As built:** `docker/{Dockerfile, Dockerfile.dockerignore, healthcheck.js, docker-compose.yml, docker-compose.external-db.yml, docker-compose.dev.yml, .env.example, Caddyfile.example}`, `scripts/{dev.mjs, docker-smoke.sh}`. Image `ghcr.io/s-ayush/surface` (SPEC-004 §14 D3). No new dependencies.
> - **Image:** about **102 MB compressed** (gzip of `docker save`, arm64) and 517 MB unpacked, against a 250 MB budget. The app is 62 MB (drizzle-orm 17 MB, zod 8 MB).
>   - `pnpm deploy --legacy --prod` keeps pnpm 10 from requiring `inject-workspace-packages` for the whole workspace. It needs the network: deploy re-resolves, so `--offline` fails.
>   - The server package now has `"files": ["bin", "dist", "migrations"]`, so `src/`, `test/` and `dev.env` stay out of the image.
>   - `postgresql-client-17` comes from apt.postgresql.org, because bookworm ships 15. The repository key is fetched in a throwaway `pgdg-key` stage and trusted only if its fingerprint matches (`PGDG_KEY_FINGERPRINT`), so the runtime image needs neither curl nor gpg. npm, corepack and yarn are removed from the runtime image.
>   - **Exception to CLAUDE.md rule 7:** `healthcheck.js` reads `PORT`/`HOST` itself (trimmed, blank = unset, like `loadConfig()`), because the health check must not load the app or its config. Recorded in SPEC-004 §5.
>   - `/app` is owned by root; `/data/{uploads,backups}` are owned by 10001. `surface` is on `PATH` (`/usr/local/bin/surface` → `/app/bin/surface.js`), so `docker compose exec app surface doctor` works.
>   - The build context is an allow-list (`Dockerfile.dockerignore`), so no root `.dockerignore` is needed.
> - **Build platform:** every stage runs on the target platform, so native production dependencies (argon2 in PLAN-001) get the right binaries. If arm64 under QEMU proves too slow in S6, compile on `$BUILDPLATFORM` and run only `pnpm deploy` per target.
> - **`VOLUME ["/data"]`** (as SPEC-004 §5), with `uploads` and `backups` as named volumes beneath it. `/data` therefore stays writable under `read_only: true`, which is what AC-4 asks for.
> - **Compose deviations from the §6 outline** (spec updated):
>   - compose doesn't build `DATABASE_URL` from `POSTGRES_PASSWORD`; `loadConfig()` does and URL-encodes it. Compose still expands `$` in `.env` (write `$$`). `app` gets `POSTGRES_PASSWORD` through the same interpolation as `db`, so a value exported in the shell can't make them disagree;
>   - `stop_grace_period: 20s` on `app`: Surface drains for up to 10 s and exits by 15 s, and Docker's default 10 s would SIGKILL it mid-drain;
>   - `POSTGRES_PASSWORD` (bundled) and `DATABASE_URL` (external) are required by interpolation, so compose fails early with a clear message;
>   - `docker-compose.external-db.yml` is a standalone file, because `depends_on: db` would otherwise still start the bundled database;
>   - Caddy gets `caddy_config` and `443/udp` (HTTP/3), and `depends_on: app`.
> - **`.env.example`** lives in `docker/` next to the compose files, which is what users download (SPEC-004 §3). It documents every §7 variable plus the compose-level ones, `DATA_DIR` included.
> - **`pnpm dev`** = `scripts/dev.mjs`: `compose up --wait` → `surface migrate` → `pnpm --parallel` server `dev` + web `dev`.
>   - **One dev database per checkout:** the compose project is `surface-dev-<folder>`, e.g. `surface-dev-surface-b`, so worktrees never share or stop each other's container and volume. `pnpm db:migrate` and `pnpm dev:db:down` go through the same script (`dev.mjs db:migrate` / `db:down`).
>   - Ctrl-C is not forwarded again (the terminal already signals the whole process group), so the server shuts down gracefully instead of seeing a second signal.
>   - It doesn't use `turbo run dev`: Turbo 2's strict env mode would drop the overrides below.
>   - Overrides: `PORT`, `SURFACE_DEV_WEB_PORT` and `SURFACE_DEV_PG_PORT`; `SURFACE_URL` and `DATABASE_URL` follow. Node `--env-file` gives the environment precedence over `dev.env`.
>   - The Vite proxy (`apps/web/vite.config.ts`, added with the user's approval) forwards every `SERVER_PREFIXES` route, matching whole path segments as the server does (`/api/x` yes, `/apikeys` no), with `/sync` as `ws: true`. It keeps the Host header and uses `strictPort`.
>   - Root scripts added: `dev:db:down`, `db:migrate`, `docker:smoke`.
> - **Verified:**
>   - `scripts/docker-smoke.sh` passes, both normally and with `SURFACE_SMOKE_READ_ONLY=1` (`read_only: true` + tmpfs `/tmp`). It checks `/readyz`, that `/` serves the web app, the Docker health check, uid 10001, a clean `surface doctor`, and JSON-only logs.
>   - `pnpm dev` on ports 3200/5200 was ready in about 5 s. `/readyz` and the API 404 answered through Vite. `doctor` passed in dev, and Ctrl-C left no listeners.
> - **For S6:**
>   - The image-checks job can reuse `docker-smoke.sh` (with `SURFACE_SMOKE_READ_ONLY=1`) and add the compressed-size check.
>   - Inside the container the public-URL check warns, because `localhost:<published port>` is the container itself. That is expected.
>   - `src/main.ts` is still the entry for the server's `dev`/`start` scripts; the image uses `bin/surface.js`.
>   - The release job must set the image's `SURFACE_VERSION` build argument (OCI label) from the same version `surface version` reports (`apps/server/package.json`).
> - **For S7 docs:** `VOLUME ["/data"]` creates an anonymous volume, so `down`/`up` without `-v` leaves orphans. `doctor`'s "/data writable" doesn't prove the `uploads` volume is writable. For plain `docker run`, use `--stop-timeout 20`.

- `docker/Dockerfile` per SPEC-004 §5 (deps, build, runtime). Uses `pnpm deploy --prod` for a minimal server bundle, plus `postgresql-client-17`, tini, and uid 10001.
- `docker/healthcheck.js` (GET `/healthz`).
- `docker/docker-compose.yml`, `docker-compose.external-db.yml` (no `db` service), `docker-compose.dev.yml` (Postgres only, for `pnpm dev`), `.env.example` (fully commented), `Caddyfile.example`.
- `pnpm dev` = start the dev Postgres, run migrations, then the server (tsx watch) and Vite (proxying `/api`, `/sync`, `/auth`, `/files`, and the WebSocket to the server).
- **Tests:** a local script `scripts/docker-smoke.sh` (build, compose up, wait for `/readyz`, compose down).

### S6: CI pipeline · M · ✅ Done 2026-11-06 (minimal; rest deferred)
> **As built:** `.github/workflows/ci.yml` only, scoped down by the user on 2026-11-06 (SPEC-004 §14 D4). On every PR and on main, with `contents: read` and cancel-superseded on PRs:
> - **`check`:** `pnpm install --frozen-lockfile` → build → lint (ESLint, dependency-cruiser, Prettier) → typecheck → unit tests. Node from `.nvmrc`, pnpm from `packageManager`, pnpm store cached by `setup-node`.
> - **`pr-title`:** commitlint on the PR title (the squash subject). The title goes through `env`, never interpolated into the script.
> - **`image`:** `docker/Dockerfile` built for linux/amd64 with buildx and the GHA cache, not pushed.
> - **Verified locally:** actionlint (rhysd/actionlint image) reports no problems. Commitlint accepts `feat(server): …` and rejects a plain sentence. The frozen install and `pnpm check` are green. **Not yet run on GitHub** (the repo has no remote), and the amd64 image build is unverified locally (only arm64 was built).
> - **Deferred until the app is up:**
>   - stage 3, integration: `pnpm test:int` with a Postgres 17 service container and `TEST_DATABASE_URL`, session A's handoff, answered as deferred;
>   - stage 5 e2e and stage 6 install smoke;
>   - the no-egress (AC-10), log-scan (AC-11) and image-check (AC-4) jobs (`scripts/docker-smoke.sh` stays available locally, `SURFACE_SMOKE_READ_ONLY=1` for AC-4);
>   - multi-arch builds and the push to GHCR (AC-5);
>   - `nightly.yml` and `release.yml`;
>   - the Turborepo remote cache.
>
>   AC-2 is therefore only partly met: stages 1, 2 and 4 run.
> - **Before stage 3 is enabled:** session A's flaky `startup.int.test.ts` (handoff in session B's file) must be fixed.
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

### S8: Install smoke & upgrade test · S *(finishes after PLAN-001 S2)* · ⏸ Deferred
> **Deferred** by the user on 2026-11-06 (SPEC-004 §14 D4), together with the CI test stages: install smoke (AC-3), restart e2e (AC-8), external-DB test (AC-13), upgrade test (AC-7). Build them once the app is up.
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
| AC-12 | `apps/server/test/doctor.int.test.ts` (each condition against real Postgres, SMTP and HTTP fixtures) + `apps/server/test/doctor.test.ts` (verdicts, incl. PG < 17, no contrib, full disk). E2 is covered by AC-9, E4 waits for the sync hub. |
| AC-13 | CI external-db job |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| arm64 builds under QEMU are slow | Native arm64 runners if available. Only build arm64 on main and tags. |
| The `pg_dump` client version mismatches the server | Pin `postgresql-client-17` and refuse backups (M7) against newer servers with a clear message |
| Testcontainers is slow in CI | Use the CI service container for integration tests, Testcontainers only locally, and template-DB cloning per file |
| The image size budget is exceeded | `pnpm deploy --prod`, no dev dependencies, slim base. A size check in CI catches regressions. |
