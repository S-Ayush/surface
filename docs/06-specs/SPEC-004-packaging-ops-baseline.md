# SPEC-004: Repository, CI & self-host packaging baseline

Status: **Accepted** (2026-11-06) · Milestone: **M0** (built **first**) · Date: 2026-11-06
Implements: FR-OPS-01, 02, 03, 04, 07, 09 · NFR-12, 16, 17, 22, 23, 24 · ADR-0001, ADR-0006, ADR-0013
Unblocks: every other spec

---

## 1. Problem & goal

Before any feature exists we need (a) a monorepo where client and server share code safely, (b) CI that enforces our quality gates from the first commit, and (c) a Docker deliverable that takes a fresh Linux VM to a running Surface in **under 15 minutes** and upgrades with a tag change. Building the packaging first means every later feature is tested the way users will run it.

## 2. Scope

**In scope**
- Monorepo skeleton (layout from [architecture §3](../04-architecture/architecture.md#3-monorepo-layout)), tooling, and conventions
- CI pipeline: lint, typecheck, unit, integration (with Postgres), e2e, image build, install smoke test
- Dockerfile (multi-stage, multi-arch, non-root) and the `surface` CLI entry point
- `docker-compose.yml` (app + db), optional Caddy profile, `.env.example`
- Config loading and validation, startup sequence, migrations under a lock, graceful shutdown
- `/healthz`, `/readyz`, structured logs, optional `/metrics`
- Install, upgrade, and reverse-proxy documentation
- The "no outbound calls" guarantee and its test
- The Content-Security-Policy header (§15)

**Out of scope:** scheduled backups and `surface restore` (M7: FR-OPS-05/06) · the System page (M7) · S3 (v2) · Kubernetes (later). M0 documents a **manual** `pg_dump` backup command.

## 3. Repository & tooling

```
surface/
├─ apps/{web,server}
├─ packages/{domain,operations,sync-client,sync-protocol,ui,editor,config}
├─ docker/{Dockerfile, Dockerfile.dockerignore, healthcheck.js, docker-compose.yml,
│          docker-compose.external-db.yml, docker-compose.dev.yml, Caddyfile.example, .env.example}
├─ e2e/                      Playwright tests + fixtures
├─ scripts/                  dev.mjs, docker-smoke.sh, seed-reference-scale.ts, release.ts
├─ docs/
├─ package.json  pnpm-workspace.yaml  turbo.json  .nvmrc  .editorconfig
```

| Tool | Choice / rule |
|---|---|
| Package manager | pnpm (pinned via `packageManager`), workspaces |
| Task runner | Turborepo (cached `build`, `lint`, `typecheck`, `test`) |
| TypeScript | 6.0 (typescript-eslint does not support 7 yet), `strict`, `noUncheckedIndexedAccess`. Packages export their source under the `@surface/source` condition, used by typecheck, Vite, Vitest and tsx, so no build is needed in development. Packages the server uses at runtime also build to `dist/`. No project references. |
| Lint / format | ESLint (flat config, type-aware) + Prettier. Custom rules: **no direct writes to synced tables outside `repo`** (SPEC-002 AC-12). Package dependency rules (architecture §3) are enforced by dependency-cruiser (`.dependency-cruiser.cjs`). |
| Tests | Vitest (unit and integration), Playwright (e2e and perf), fast-check (property) |
| Integration DB | Testcontainers Postgres 17 (CI service container) |
| Commits | Conventional Commits. Changesets for release notes. |
| Node | `.nvmrc` = 24 (LTS) |

**Developer loop:** `pnpm dev` starts the Postgres container (`docker-compose.dev.yml`), applies migrations, then runs the server in watch mode and Vite with an HMR proxy to the server (open `http://localhost:5173`). `PORT`, `SURFACE_DEV_WEB_PORT` and `SURFACE_DEV_PG_PORT` move the server, Vite and Postgres to other ports (`SURFACE_URL` and `DATABASE_URL` follow). Each checkout gets its own dev database (compose project `surface-dev-<folder>`), so git worktrees never share one. `pnpm dev:db:down` stops it, keeping its data. `pnpm db:migrate`, `pnpm db:seed` (demo workspace), and `pnpm db:seed:ref` (reference scale, NFR-10) are also available.

## 4. CI pipeline

Runs on every PR and on main. Example on GitHub Actions; the stages are portable to any CI.

| Stage | Contents | Gate |
|---|---|---|
| 1. Static | install (frozen lockfile), lint, typecheck, registry lint (SPEC-003 §11) | must pass |
| 2. Unit | Vitest across packages | must pass, coverage reported |
| 3. Integration | Server and sync tests against Postgres; sync simulation property tests (SPEC-002 AC-2, 1,000 cases on main, 200 on PRs) | must pass |
| 4. Build | Web and server build; Docker image (amd64 on PRs; amd64 + arm64 on main) | must pass |
| 5. E2E | Playwright against the **built image** via compose (2 browsers for real-time tests) | must pass |
| 6. Install smoke | Fresh `docker compose up` from `docker/` with only `.env.example` filled in. Wait for `/readyz`, then a Playwright J1-mini: read the setup token from the logs, complete setup, create a team. | must pass |
| 7. Perf (nightly) | Reference-scale seed plus budget assertions (NFR-01–05) | must pass on main nightly; trend tracked |
| Release (tag) | Multi-arch push: `surface:x.y.z`, `x.y`, `latest`; release notes from changesets | manual approval |

## 5. Docker image

```dockerfile
# docker/Dockerfile (outline)
FROM node:24-bookworm-slim AS deps        # pnpm fetch with lockfile
FROM deps AS build                        # turbo build web + server; pnpm deploy --prod server → /out
FROM node:24-bookworm-slim AS runtime
RUN apt-get install -y --no-install-recommends postgresql-client-17 tini ca-certificates \
 && useradd --uid 10001 --create-home surface
COPY --from=build /out /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data MALLOC_ARENA_MAX=2   # E10
VOLUME ["/data"]                          # /data/uploads, /data/backups
USER surface
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node /app/bin/healthcheck.js
ENTRYPOINT ["tini","--","node","/app/bin/surface.js"]
CMD ["serve"]
```

| Requirement | Value |
|---|---|
| Architectures | linux/amd64, linux/arm64 |
| Native modules | sharp (images) and `@node-rs/argon2` (passwords) ship prebuilt per CPU and libc. The runtime stage loads both and encodes one WebP, so the build fails on a platform where either can't load, rather than uploads answering `503` after deploy (added 2026-11-12, PLAN-001 S6 follow-up). |
| User | Non-root uid 10001. Writable dirs: `/data` only. Read-only root filesystem compatible. |
| Health check | `healthcheck.js` GETs `/healthz` on loopback. It is the one reader of `PORT`/`HOST` outside `loadConfig()` (same trimming rules), because it must not load the application or its configuration. |
| Size target | < 250 MB compressed |
| Memory | Runs in a 512 MB container (E10): about 110 MB idle; image uploads are what can grow it. |
| Contents | Server bundle, web static assets (served by the server: hashed filenames immutable; `index.html` and the offline worker `sw.js`, ADR-0019, `no-cache`), `pg_dump`/`pg_restore` 17, the `surface` CLI |
| Labels | OCI labels: version, revision, source |

## 6. Compose

```yaml
# docker/docker-compose.yml (outline)
name: surface
services:
  app:
    image: ${SURFACE_IMAGE:-ghcr.io/s-ayush/surface}:${SURFACE_VERSION:-latest}
    env_file: .env          # DATABASE_URL defaults to postgres://surface:<POSTGRES_PASSWORD>@db:5432/surface (§7)
    environment: { POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?}" }   # the same value `db` gets
    ports: ["${SURFACE_BIND:-0.0.0.0}:${SURFACE_PORT:-3000}:3000"]
    volumes: ["uploads:/data/uploads", "backups:/data/backups"]
    depends_on: { db: { condition: service_healthy } }
    stop_grace_period: 20s  # > the 15 s shutdown of §8; Docker's default 10 s would SIGKILL mid-drain
    restart: unless-stopped
  db:
    image: postgres:17
    environment: { POSTGRES_USER: surface, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?}", POSTGRES_DB: surface }
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U surface"], interval: 5s, retries: 20 }
    restart: unless-stopped
  caddy:                                   # optional: docker compose --profile proxy up -d
    profiles: ["proxy"]
    image: caddy:2
    ports: ["80:80","443:443","443:443/udp"]       # 443/udp: HTTP/3
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro","caddy_data:/data","caddy_config:/config"]
    depends_on: [app]
    restart: unless-stopped
volumes: { pgdata: {}, uploads: {}, backups: {}, caddy_data: {}, caddy_config: {} }
```

- **Using an external DB:** set `DATABASE_URL` in `.env` and use `docker-compose.external-db.yml`, the same file without the `db` service (`docker compose -f docker-compose.external-db.yml up -d`, or `COMPOSE_FILE=docker-compose.external-db.yml` in `.env` so every command uses it). It refuses to start without `DATABASE_URL`.
- **`DATABASE_URL` is not composed by compose:** Surface builds the default from `POSTGRES_PASSWORD` and URL-encodes it, so URL-special characters in the password are safe. Compose itself expands `$` in `.env`, so a literal `$` is written `$$` (the generated hex passwords need nothing). `app` receives `POSTGRES_PASSWORD` through the same interpolation as `db`, so a value exported in the shell can't make them disagree. `docker-compose.yml` refuses to start without it.
- **Compose-level settings in `.env`:** `SURFACE_VERSION` (tag), `SURFACE_IMAGE` (repository), `SURFACE_BIND`, `SURFACE_PORT`. Surface ignores them.
- **Caddy example:** `surface.example.com { reverse_proxy app:3000 }` (WebSocket upgrade works by default). There are also notes for nginx (`Upgrade`/`Connection` headers, `proxy_read_timeout 1h`) and Traefik.

## 7. Configuration

All configuration is through environment variables, validated at startup with a Zod schema. On error the process exits with a clear, actionable message (`SESSION_SECRET is missing. Generate one with: openssl rand -hex 32`).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SURFACE_URL` | ✓ | — | Public base URL (`https://surface.example.com`), used in links, cookie `Secure` and HSTS. Just the origin: no path, query, user name or password |
| `SESSION_SECRET` | ✓ | — | ≥ 32 bytes hex. Signs CSRF tokens and similar. |
| `POSTGRES_PASSWORD` | ✓ (bundled DB) | — | |
| `DATABASE_URL` | | composed | Supports `?sslmode=require` for managed DBs |
| `SMTP_URL` | | — | `smtp(s)://user:pass@host:port`. Unset means no-SMTP mode. `smtps://` is TLS from the first byte (port 465 by default). `smtp://` (587 by default) upgrades with STARTTLS whenever the server offers it, and **requires** it when the URL has a user name, so the password never travels unencrypted. The server's certificate is always verified. |
| `SMTP_FROM` | with SMTP | — | `Surface <surface@example.com>` |
| `UPLOAD_MAX_MB` | | 25 | The largest attachment or inline upload. Avatars and logos stay at 2 MB. Uploads are also refused when they would leave less than 1 GB free on the uploads volume (`507`, E6; SPEC-014 §4.6) |
| `MCP_ENABLED` | | true | Effective in M6 |
| `SURFACE_SETUP_TOKEN` | | random | Fixed setup token, 16–128 characters (SPEC-001 §3.1, Q4). Set it when more than one container serves HTTP |
| `SURFACE_ROLE` | | all | all \| web \| worker |
| `LOG_LEVEL` | | info | |
| `METRICS_ENABLED` | | false | Exposes `/metrics` |
| `TRUST_PROXY` | | true | Trust the one reverse proxy in front, if it connects from a loopback, private or link-local address: the client address is the last `X-Forwarded-For` entry (the one that proxy added), and the scheme and host are the last `X-Forwarded-Proto`/`-Host` entries. Set `false` when Surface is reachable without a proxy (D6). |
| `BACKUP_SCHEDULE`, `BACKUP_RETENTION` | | — | Effective in M7 |
| `PORT`, `HOST` | | 3000, 0.0.0.0 | Listen address *inside* the container. The host-side binding is `SURFACE_BIND`/`SURFACE_PORT` in compose. |
| `SURFACE_WEB_DIR` | | `apps/web/dist` | Location of the built web app. Set by the image; rarely changed. |
| `DATA_DIR` | | `/data` | Writable volume for uploads and backups. Set by the image. A relative path is resolved against the working directory. Startup (E5, §8) and `surface doctor` (E5, E6) check it and its `uploads` folder. |
| `NODE_ENV` | | production | `development` is set by `pnpm dev` |

`SURFACE_COMMIT` is baked into the image at build time and reported by `/readyz` logs and `surface version`. It is not user configuration. All problems are reported at once, and secret values (`SESSION_SECRET`, passwords in `DATABASE_URL` and `SMTP_URL`) are never echoed in errors.

`.env.example` documents every variable with a comment. The README has a one-liner that generates the secrets.

## 8. Process lifecycle

**Startup** (`surface serve`):
1. Load and validate config (fail fast). Then, once listening, check that `DATA_DIR` and its `uploads` folder (created when missing) are writable directories, by writing and removing a probe file in each (E5, added 2026-11-12), before the database wait.
2. Connect to the DB with retry for up to 60 s, logging "waiting for database…". Wrong credentials, a `pg_hba.conf` rejection (with a hint about `?sslmode=require`) or a missing database fail at once, with the server's reason and never the password.
3. Check the Postgres version (≥ 17) and that the ICU collation `und-x-icu` exists (text filters lowercase with it, SPEC-003 §7.4). An unsupported server exits with instructions before anything is changed.
4. Under `pg_advisory_lock(LOCKS.migrations)`, so concurrent replicas wait their turn:
   - create the required extensions (`pg_trgm`) if missing and permitted; otherwise exit with the SQL an administrator must run (E8). Nothing else has been changed at that point;
   - run **migrations**. A failed migration exits non-zero, with the DB unchanged by it (each migration runs in its own transaction). History is kept in `schema_migrations`, including the Surface version that applied each migration (used for E7).
5. If setup is incomplete, generate or log the setup token (SPEC-001).
6. Start the job worker (by role), HTTP, and WebSocket. `/readyz` turns ready.

**Shutdown** (SIGTERM / SIGINT):
1. `/readyz` → 503, and new connections are refused.
2. Open WebSockets are closed with code `1012` (service restart). Clients reconnect with backoff.
3. In-flight requests are drained (up to 10 s), the job worker stops (finishing the current job or releasing it), and the DB pool closes.
4. Exit 0 within 15 s, or exit forced.

**Health**
- `/healthz` → 200 if the event loop is responsive (used by the Docker HEALTHCHECK).
- `/readyz` → 200 only when the DB is reachable, migrations are current, and the server is not shutting down. JSON details for operators: `{ db: "ok", migrations: "current", version }`.
- During a rolling upgrade, once a newer replica has migrated, older replicas see migrations they don't know and report 503 (`migrations: "failing"`). This is deliberate: the proxy stops routing to code that predates the schema. Replace old replicas promptly.

## 9. CLI (`surface <command>`)

| Command | M0 | Purpose |
|---|---|---|
| `serve` | ✓ | Default: run the server |
| `migrate` | ✓ | Steps 2–4 of §8 (wait for the DB, version and collation checks, extensions and migrations under the lock), then exit. For CI and manual upgrades. |
| `setup-token` | ✓ | Print a fresh setup URL if setup is incomplete; earlier links stop working (SPEC-001 Q4). Exits 1 once setup is complete. Implemented in PLAN-001 S2. |
| `reset-password <email>` | ✓ | Print a one-time reset link (the recovery path when no Admin can log in). Valid 1 hour and single-use; the user's earlier reset links stop working, and using it logs them out everywhere (SPEC-001 §3.3). Exits 1 for an email without an active user. Implemented in PLAN-001 S4. |
| `doctor` | ✓ | Check config, DB connectivity and version, ICU collations, extensions, disk space on `/data`, SMTP connectivity, and `SURFACE_URL` reachability (local only) |
| `version` | ✓ | Print the version, commit, and schema level (`--json` for scripts). The schema level is the newest migration in the build; the sync `schemaHash` is added with PLAN-002. |
| `backup`, `restore <file>` | M7 | FR-OPS-05/06 |

Usage: `docker compose exec app surface doctor`. Exit codes: `0` success, `1` the command failed, `2` wrong usage.

**`doctor`** is read-only (it creates no extension, applies no migration and leaves no file behind) and prints one line per check: ✓ ok, ! warning, ✗ problem, - skipped. It exits 1 if any check is a problem; warnings exit 0. `--json` prints the same report for scripts. It never prints secrets.

| Check | Problem (✗) | Warning (!) |
|---|---|---|
| Configuration | Any `loadConfig()` error; every other check is then skipped | |
| Database | Unreachable (E1, no retry), wrong credentials, `pg_hba.conf` rejection, missing database | |
| PostgreSQL version | Older than 17 (E8) | |
| Collations | A required ICU collation (`und-x-icu`) is missing, so the server was built without ICU (§8 step 3, E8). Same message as startup. | |
| Extensions | `pg_trgm` unavailable, or not installed and the user may not create it (prints the SQL to run) (E8) | |
| Migrations | Applied by a newer Surface (E7), or an applied migration was edited | Pending (applied at startup or by `surface migrate`) |
| Data directory | `DATA_DIR` missing, not a directory, or not writable; or its `uploads` folder exists and isn't a writable directory (E5, names uid 10001). Same messages as startup. | |
| Disk space | Under 100 MB free on `DATA_DIR` (E6) | Under 1 GB free (uploads are refused below 1 GB free: E6, SPEC-014 §4.6) |
| Email (SMTP) | When `SMTP_URL` is set: no connection, or no `220` greeting within 5 s. Credentials are not tested. | |
| Public URL | | `GET <SURFACE_URL>/healthz` from this host fails, redirects (reported with its target, never followed), or is not Surface (E3), or plain `http` on a non-local host |

## 10. Observability

- **Logs:** pino JSON to stdout. Fields: `time`, `level`, `msg`, `reqId`, `actorKind`, `op`, `durationMs`, `status`. Secrets and tokens are redacted by path (`req.headers.cookie`, `authorization`, `*.password`, `*.token`).
- **Metrics (opt-in):** HTTP latency, op latency per name, sync broadcast lag, WebSocket connections, job queue depth and failures, DB pool usage, bootstrap duration and size.
- **No telemetry** (FR-OPS-09): no analytics, update checks, crash reporters, CDN fonts, or external scripts. The web app is fully self-contained (fonts bundled).

## 11. Documentation deliverables

| Doc | Content |
|---|---|
| `README.md` | What Surface is, plus a **15-minute install**: prerequisites (Docker Engine + Compose plugin, 2 vCPU / 2 GB / 20 GB) → get `docker/` (a clone of the repository) → fill `.env` → `docker compose up -d` → open the setup URL from `docker compose logs app`. Until the first release is published, the image is built from the clone. |
| `docs/ops/reverse-proxy.md` | Caddy (recommended), nginx, Traefik. WebSocket and timeout notes. |
| `docs/ops/upgrade.md` | Bump `SURFACE_VERSION`, then `docker compose pull && docker compose up -d`. Covers rollback policy (DB migrations are forward-only, so take a backup first). |
| `docs/ops/backup-manual.md` (M0) | `docker compose exec -T db pg_dump -U surface surface \| gzip > surface-$(date +%F).sql.gz` (`-T`: no terminal, so no carriage returns in the dump), the uploads volume as a tarball, a daily backup script that never prunes after a failed dump, and a restore procedure |
| `docs/ops/troubleshooting.md` | `surface doctor`, every startup error with its fix, common errors (wrong `SURFACE_URL`, proxy without WebSocket upgrade, DB auth, a `POSTGRES_PASSWORD` changed after the first start), `/data` permissions and leftover anonymous volumes |

## 12. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | The DB isn't ready when the app starts | Retry for 60 s, then exit non-zero (compose restarts it) |
| E2 | Two app replicas start at once | The migration lock serializes them. The second sees "migrations current". |
| E3 | `SURFACE_URL` doesn't match the browser origin | Login fails CSRF/origin checks. `doctor` and the troubleshooting doc explain it, and the server logs a warning on mismatched `Origin` headers. |
| E4 | The reverse proxy strips WebSocket upgrades | The client shows "Live updates unavailable, check proxy config" after 3 failed upgrade attempts, with a link to the docs |
| E5 | The `/data` volume isn't writable | Exit at startup with a message about volume permissions (uid 10001): `DATA_DIR` missing, not a directory, or not writable, then the same for `DATA_DIR/uploads`, where uploads are stored (its own volume in the compose files; created when missing). `surface doctor` reports the same facts with the same messages. It runs before the database wait (§8), in every role. `DATA_DIR/backups` isn't checked: the server doesn't write it in v1 (the manual backup runs `pg_dump` in the database container). Added 2026-11-12 with the first feature that writes to `/data` (uploads, PLAN-001 S6; D9). |
| E6 | Disk is full | Uploads fail with a clear error: `507 INSUFFICIENT_STORAGE`, "The server is almost out of disk space. Ask an Admin to free some." (SPEC-014 §6.4). From M1 an upload is refused before it is read when it would leave less than 1 GB free on the uploads volume, the same threshold as `doctor`'s warning (SPEC-014 §4.6). `doctor` reports it. The DB's own disk errors surface as `INTERNAL` with logs. *Changed 2026-11-12 (SPEC-014, M1 gate): the error and the floor.* |
| E7 | Downgrading the image after a migration | The server detects a DB schema newer than the code and exits: "Database was migrated by a newer Surface (x.y). Restore a backup or upgrade." |
| E8 | Postgres < 17, a server built without ICU (no `und-x-icu`), or `pg_trgm` unavailable on a managed DB | Exit with explicit instructions |
| E9 | Surface is served over plain `http://` to other machines (no TLS) | Browsers withhold features that need a secure context (HTTPS, or `localhost` on the same machine): **reloading while offline or while the server is down** doesn't work, because the offline worker (ADR-0019, PLAN-005 S9) doesn't run, so the app needs the server to load; a change made offline can take **up to 15 s** to reappear after a reload, because tabs hand their queue over by lease instead of Web Locks (SPEC-002 E5); and **copying a reset link** to the clipboard fails (the link can still be selected and copied by hand). Changes made offline in an open tab are still kept and sent later (SPEC-002 AC-6). For all three, put Surface behind a TLS-terminating proxy (`docs/ops/reverse-proxy.md`) and set an https `SURFACE_URL`. |
| E10 | Many image uploads at once (any member can send them) in a small container (512 MB) | The server keeps running. Image decoding is native memory, outside the JS heap, so `--max-old-space-size` doesn't bound it (`files/image.ts`): images over 25 MP are refused from their header before any decoding; at most 2 decode at once and the rest wait in arrival order, at most 16 of them (`503 UNAVAILABLE` with `Retry-After` beyond: each waiting upload holds its body, up to 2 MB); one whose client has gone is skipped; each uses one libvips thread and no operation cache. One user may upload 10 a minute (`429`, SPEC-001 §6.1). The image sets `MALLOC_ARENA_MAX=2`, which makes sharp's own default one thread per core on glibc, so `sharp.concurrency(1)` in `image.ts` is what keeps it at one. Measured in D10. |

## 13. Acceptance criteria

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `git clone` → `pnpm i` → `pnpm dev` gives a working dev environment (DB, server, web with HMR) in under 5 minutes on a clean machine with Docker and Node. | manual + CI script |
| AC-2 | CI runs stages 1–6 on every PR. A violation of the synced-table write rule or the package dependency rule fails lint. | CI |
| AC-3 | **Install smoke:** on a clean Ubuntu LTS VM with Docker, the README steps reach a completed setup and a first team in **< 15 min** (scripted in CI; also verified manually once per release). | CI + manual |
| AC-4 | The image runs as uid 10001, works with `read_only: true` (plus a writable `/data` and `/tmp`), and is under 250 MB compressed. | CI |
| AC-5 | The image builds and runs on amd64 and arm64. | CI |
| AC-6 | Invalid or missing config exits within 1 s with a message naming the variable and how to fix it. | integration (exit code and message); the 1 s budget is checked by hand (D7) |
| AC-7 | Upgrading from version N-1 to N (tag change plus `up -d`) migrates automatically and preserves data. Tested in CI with the previous release image and a seeded DB. | CI |
| AC-8 | SIGTERM shuts down within 15 s. Connected clients reconnect automatically after the restart, with no lost queued mutations. | e2e |
| AC-9 | `/readyz` is 503 during migrations and shutdown, and 200 otherwise. `/healthz` stays 200 while the process is alive. | integration |
| AC-10 | **No outbound calls:** with the app container on an internal-only Docker network (no egress) and SMTP unset, the full e2e suite passes. | CI |
| AC-11 | Logs are JSON. A test greps logs from an auth and API-key flow and finds no passwords, tokens, or cookies. | CI |
| AC-12 | `surface doctor` reports each failure condition in §12 correctly (fixture per condition). | integration |
| AC-13 | Running with an external `DATABASE_URL` (no `db` service) works end to end. | CI |
| AC-14 | Every response the app routes (pages, assets, API, errors, health) carries the §15 policy. It allows the theme bootstrap by its sha256 hash and has no `'unsafe-inline'`, `'unsafe-eval'` or wildcard source. | unit |

## 14. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Image registry? | GitHub Container Registry (`ghcr.io`), public |
| Q2 | Should port 3000 bind to `0.0.0.0` or `127.0.0.1` by default? | `0.0.0.0`, so it works without a proxy on a LAN. The docs recommend `SURFACE_BIND=127.0.0.1` when using Caddy. |
| Q3 | Should the bundled Caddy profile be the default install path? | No. It is optional, because many teams already have a proxy. The README shows both. |
| Q4 | Which CI provider? | GitHub Actions (the stages are portable) |
| D1 | (2026-11-06, PLAN-004 S3) Where do compatibility checks run relative to migrations? | §8 reordered: version check, then extensions and migrations together under the migrations lock. An incompatible database is never partly migrated, and concurrent replicas never race on `CREATE EXTENSION`. |
| D2 | (2026-11-06, PLAN-004 S4) What does `doctor`'s "`SURFACE_URL` reachability (local only)" mean, and is a failure fatal? | One `GET <SURFACE_URL>/healthz` from the Surface host itself, never through a third-party service. It is only a **warning**, because a host often cannot resolve its own public name (split DNS, hairpin NAT), and because the no-egress rule (FR-OPS-09) must hold even when the operator runs `doctor`. |
| D3 | (2026-11-06, PLAN-004 S5) Which GHCR owner (Q1)? | `ghcr.io/s-ayush/surface`, overridable with `SURFACE_IMAGE` in `.env`. |
| D4 | (2026-11-06, PLAN-004 S6) Build the full §4 pipeline now? | No, by decision of the user. CI runs stages 1, 2 and 4 now (static, unit, build including the Docker image for amd64, unpushed). Stage 3 integration, 5 e2e, 6 install smoke, the no-egress / log-scan / image checks, multi-arch, nightly and release are built once the app is up, together with PLAN-004 S8. Until then AC-2, AC-3, AC-4 (in CI), AC-5, AC-7, AC-8, AC-10, AC-11 and AC-13 are not enforced by CI. |
| D5 | (2026-11-06, PLAN-004 S9) How does the CSP allow the inline theme bootstrap (PLAN-005 S1)? | By its sha256 hash, computed at startup from the `index.html` the server serves (§15). Architecture's "no inline scripts" stands for everything else. A nonce would need the page rewritten per request; a hash fixed at build time could drift from the file the image ships. |
| D6 | (2026-11-06, PLAN-004 S10, revised after review) What does `TRUST_PROXY=true` trust? | Exactly one hop, and only from a private address: the peer that connects to the server is the proxy if its address is loopback, private, link-local or shared (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped included); nothing before it is trusted. Fastify's `trustProxy: true` trusts every hop, so the client address became the left-most `X-Forwarded-For` entry, which the client writes, and per-IP sign-in limits (ADR-0007) could be bypassed. A hop count (`1`) trusts nobody in the installed Fastify (5.12.8), and Fastify's docs call a hop-only trust function unsafe when the server can be reached directly: a forgotten `SURFACE_BIND` would let anyone on the internet set their address. With the address check, only a client on the LAN or VPN can, which is why installs without a proxy still set `TRUST_PROXY=false`. A proxy that connects from a public address isn't trusted (fail closed: every user shows the proxy's address). Behind two proxies (a CDN, then nginx) the address is the outer proxy's (the CDN's), so all users would share one address for sign-in limits; not supported in v1. **Added 2026-11-07 (PLAN-001 S9 security review L3):** Docker can forward outside clients from its own private gateway address (rootless Docker, Docker Desktop and Colima, IPv6 clients through `docker-proxy`), and they are then trusted. So with `TRUST_PROXY=true` the published port must be private (`SURFACE_BIND`), as `reverse-proxy.md` and `.env.example` now say. The server can't see how compose publishes its port, so `doctor` doesn't check this. |
| D7 | (2026-11-07, by decision of the user) Should tests assert wall-clock budgets? | No. The AC-6 tests (`config-exit.test.ts`, `cli.test.ts`) check the exit code and the message only. Their "< 1 s" checks failed when several sessions shared the machine (about 1.08 s at load average 12) and passed when run alone, so they measured the machine, not the code. The 1 s budget stays in AC-6 and is checked by hand. |
| D8 | (2026-11-12, PLAN-005 S9 handoff, ADR-0019) What changes for the offline app cache? | The server sends the worker `sw.js` with `no-cache`, like `index.html`, so no cache keeps an old one and it never takes the assets' year-long policy (§5). E9 names what plain `http://` loses: offline reloads, Web Locks, the clipboard. No CSP change: `worker-src` falls back to `script-src 'self'`. |
| D9 | (2026-11-12, before PLAN-001 S6 uploads) What does the server add before it stores files? | The E5 startup check, which was waiting for the first feature that writes to `/data`: startup now stops on a `DATA_DIR` or `DATA_DIR/uploads` (its own volume in compose) that is missing, not a directory or not writable, with `surface doctor`'s message, before the database wait, so a bad volume is found at deploy and not at the first upload. The check and its messages live in `src/data-dir.ts`, shared by startup and doctor. And `X-Content-Type-Options: nosniff` on every response (§15), so a stored file is never sniffed into a script or a page. Tests and the testing entry use the OS temp directory; `pnpm dev` (`scripts/dev.mjs`) already creates `data/`, and a bare `surface serve` on a fresh checkout says to create it. |
| D10 | (2026-11-12, the user's request: could a 512 MB host such as Render run the app server?) What memory does the server need? | Measured with the release image at `bbe4b31`, `--memory=512m` and no swap, a separate Postgres, 5 users with open sockets: idle 111 MB (process RSS), 137 MB after setup and sign-ups, 170 MB at most for 12 MP avatars 5 at a time, bootstraps and synced changes. But S6 put no limit on how many images decode at once, up to 40 MP, which a 0.12 MB file can declare (sharp already used one libvips thread: its own default on glibc while `MALLOC_ARENA_MAX` is unset): 20 such uploads at once reached 496 MB, and 30 got the server OOM-killed. With `MALLOC_ARENA_MAX=2` and one libvips thread (`VIPS_CONCURRENCY=1`, since that variable lifts sharp's default), 100 at once peaked at 371 MB, and about 350 MB stayed allocated afterwards (sharp caps its cache at 50 MB, so most is likely freed memory glibc kept; not attributed further). So (E10): 25 MP from the header, at most 2 decodes at once and 16 waiting, one thread each, no cache, 10 uploads a minute per user, and `MALLOC_ARENA_MAX=2` in the image. `VIPS_CONCURRENCY` isn't set: `sharp.concurrency(1)` does the same, and must stay. After the change (same setup, without the rate limit, so one member's burst all got through, with 0.08 MB files): 156 MB at most for normal use; 40 MP images refused; 30, 60 and 100 uploads at once at the 25 MP limit peaked at 234, 238 and 246 MB process RSS (184, 184 and 190 MB container), so the peak no longer grows with the burst. Those bursts ran before the waiting limit: with it, uploads beyond 18 at once are refused with `503`, so the peak can only be lower. 2 MB bodies add up to 36 MB at most (2 decoding, 16 waiting). Measured on arm64 (Render is amd64) with a tiny workspace. |
| D11 | (2026-11-12, M1 acceptance gate, SPEC-014 §12) What is E6's "clear error", and when are uploads refused? | `507 INSUFFICIENT_STORAGE` with SPEC-014 §6.4's message (a new SPEC-003 §9 code). Attachment and inline uploads are refused below a fixed 1 GB free-space floor on the uploads volume, checked before reading and again before the rename; it matches `doctor`'s 1 GB warning. Fixed constants in M1 (SPEC-014 Q14); configurable quotas come with FR-OPS-08 and then follow architecture rule 7. |

## 15. Security headers (PLAN-004 S9)

Every response, the JSON API and errors included, carries this `Content-Security-Policy`:

| Directive | Sources | Why |
|---|---|---|
| `default-src` | `'self'` | Nothing loads from another origin (no CDNs, no external fonts, FR-OPS-09). |
| `script-src` | `'self'` + `'sha256-…'` for each inline script in the served `index.html` | The theme bootstrap must run before the first paint (PLAN-005 S1). There is one inline script, and an `apps/web` test keeps it one. No `'unsafe-inline'`, no `'unsafe-eval'`. |
| `style-src` | `'self'` | The build ships one stylesheet. React sets `style` through the CSSOM, which CSP doesn't restrict. |
| `font-src` | `'self' data:` | Vite inlines small font files as `data:` URIs. |
| `img-src` | `'self' data: blob:` | Inlined images and local previews of files being uploaded. |
| `connect-src` | `'self'` | The API and the same-origin WebSocket (`/sync/ws`). |
| `object-src`, `base-uri` | `'none'` | No plugins; a `<base>` tag can't redirect relative script URLs. |
| `form-action` | `'self'` | Forms post only to the server. |
| `frame-ancestors` | `'none'` | Surface can't be framed (clickjacking). |

- The server reads `index.html` once at startup. When the web app isn't built, `script-src` is `'self'` only.
- A library that probes for `eval` (Zod checks whether it can compile schemas) is refused, and falls back. Turn the probe off rather than allow `'unsafe-eval'`.
- A library that injects a `<style>` element is blocked by `style-src 'self'`. Import its CSS through Vite instead (TipTap: `injectCSS: false`).
- Responses Fastify writes without routing (the 503 while closing, malformed-request errors) skip the hook. None of them is HTML.
- `X-Content-Type-Options: nosniff` is sent on every response too (2026-11-12, D9): browsers use the sent type and never guess one from the bytes, so a stored file can't run as a script or a page.
- The cookie flags in the architecture's security row come with auth (PLAN-001 S3). HSTS (`Strict-Transport-Security: max-age=31536000`, without `includeSubDomains` or `preload`) is sent on every response when `SURFACE_URL` is https (PLAN-001 S9). Browsers ignore it over plain http, so it is right behind a TLS-terminating proxy too.
