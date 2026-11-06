---
paths:
  - 'apps/server/**'
---

# Server (apps/server)

Spec: `docs/06-specs/SPEC-004-packaging-ops-baseline.md` (config, lifecycle, logging, health). PLAN-004 "As built" notes describe the current structure.

- **Structure:** `app.ts` builds the Fastify instance and has no side effects (no listen, no signals), so tests use `buildApp()` + `inject()`. `server.ts` (`serve()`) owns startup order. `main.ts` validates config before importing anything heavy.
- **Startup order** (SPEC-004 §8): listen → wait for DB → check Postgres version → (under the migrations lock) extensions + migrate, via `prepareDatabase()` → setup token → workers/hub → `lifecycle.markReady()`. `/readyz` must be 503 until the end of that sequence.
- **Startup failures** the operator must fix throw `StartupError` (`src/startup-error.ts`) with a message saying what to do. `serve()` logs it as one fatal line and exits 1. Use `startServer()` in tests.
- **Configuration:** only `loadConfig()` reads `process.env`. To add a variable, update the schema in `config.ts`, `test/config.test.ts`, `.env.example` and the SPEC-004 §7 table in the same change. Error messages name the variable and the fix, and never echo the value of a secret.
- **Lifecycle:** resources that need cleanup register `lifecycle.onShutdown('connections' | 'resources', name, fn)`. Things that gate readiness register `lifecycle.addReadinessCheck(name, fn)`. Don't add ad-hoc `process.on('SIGTERM')` handlers.
- **Logging:** use `request.log` inside requests and the app logger elsewhere. Never use `console.*`. Log objects, not interpolated strings: `log.info({ teamId }, 'team created')`. Never log request bodies, headers, tokens or passwords. New credential-carrying URL shapes go in `SENSITIVE_PATH_PATTERNS` / `SENSITIVE_QUERY_PARAMS` in `logger.ts`, with a test.
- **HTTP errors:** throw or return the SPEC-003 error shape via `errorBody()`. Routes under the server prefixes (`/api/`, `/sync/`, `/auth/`, `/files/`, `/mcp`) are listed in `http/static.ts` `SERVER_PREFIXES`. Add new top-level prefixes there so the SPA fallback never shadows them.
- **Mutations:** nothing changes state outside the operation executor (see `operations.md`). HTTP routes for auth, setup and files are the documented exceptions in SPEC-001/SPEC-004.
- **Security headers:** the CSP (SPEC-004 §15) is built in `src/http/security-headers.ts` and sent on every response. Never add `'unsafe-inline'`, `'unsafe-eval'` or another origin: the only inline script is the theme bootstrap, allowed by the hash of the served `index.html`.
- **Node APIs:** use the `node:` prefix (`node:fs`, `node:crypto`). Use `crypto.randomUUID()` and `crypto.randomBytes()` for ids and tokens. Never use `Math.random()` for anything security-related.
