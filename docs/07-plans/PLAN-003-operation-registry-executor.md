# PLAN-003: Operation Registry & executor

Implements: [SPEC-003](../06-specs/SPEC-003-operation-registry-executor.md) · Status: **Ready** · Order: **2nd** · Depends on: PLAN-004 S1–S3

---

## 1. Slices

### S1: Registry core (`packages/operations`) · M
- `defineOperation()` with the full field set of SPEC-003 §3.1, typed generics so `input` and `output` types flow to the client `dispatch` and the server `handler`.
- A `registry` map built from an explicit `index.ts` barrel (no filesystem globbing, so the code is tree-shakeable for the client).
- Name, domain, and summary validation at definition time (throws in dev and tests).
- **Schema export:** `toJsonSchema()` (Zod JSON Schema export plus `x-surface-ref` annotations) and `toCompactSchema()` (flat field map).
- `ui` metadata types (title, icon, contexts, shortcut).
- **Tests:** definition validation, schema export snapshots, compact schema token estimate < 400 (AC-10).

### S2: Reference types & resolvers · M
- `packages/domain/refs.ts`: Zod ref types `TeamRef`, `UserRef`, `StatusRef`, `LabelRef` (and stubs for Issue, Cycle, Project, Initiative, Document, View, which throw "not available until M1+").
- Parsing of each format (uuid, key, email, displayName, `me`, names).
- **Server resolver interface** `resolve(def, input, actor, tx)`: dependency-ordered (scoped refs after their scope), with visibility applied via `sync_groups && actorGroups`, ambiguity errors carrying candidates, and invisible rows reported as `NOT_FOUND`.
- **Client resolver interface** over the store, implemented in PLAN-002 S6. Only the interface is defined here.
- **Tests:** a resolver test per ref type and format, plus ambiguity and invisibility (AC-2), using fixture tables in the test DB.

### S3: Actor & permission predicates · S
- `Actor` = `{ kind: user|api|mcp|system, userId?, role?, groups: string[], apiKey?: {scope, teamIds, allowDestructive} }`.
- Predicate helper `p`: `any`, `admin`, `self`, `teamMember`, `owner`, `canSee`, each with a human-readable failure reason.
- Key-scope checks (read keys allow queries only; `destructive` requires `allowDestructive`; `teamIds` narrowing). These are unit-tested now and wired to real keys in M6.
- Test helpers `actorFor(user)` and `systemActor()`. Sessions are wired in PLAN-001 S3.

### S4: Executor pipeline · L
- `apps/server/src/executor/execute.ts` implementing the SPEC-003 §6 steps 1–14.
- Transaction wrapper: `READ ONLY` for queries, and up to 3 retries with jitter on serialization or deadlock errors (E5).
- **Handler context:** `actor`, `refs`, `tx`, `repo`, `query`, `emit`, `now`, `log`. `repo` is an **interface** here, with a temporary passthrough implementation that writes rows and buffers changes. PLAN-002 S2 replaces it with the sync-logging repo.
- **Outbox:** a migration for `event_outbox` (`id`, `type`, `occurred_at`, `actor`, `subject`, `changes`, `data`, `processed_at`). `emit()` buffers events and inserts them before commit.
- **Error model:** `SurfaceError` classes with codes, the HTTP mapping table, correlation IDs, and `INTERNAL` that never leaks a stack.
- **Logging and metrics:** `op`, `actorKind`, `durationMs`, `outcome`, and a histogram per operation.
- **Test-only ops:** `debug.echo` (query) and `debug.touch` (mutation), both marked `internal`.
- **Tests:** stage-by-stage failures (AC-3), read-only enforcement (AC-4), atomic rollback with an injected failure after the handler (AC-5), overhead benchmark < 2 ms p95 (AC-11), and 50 concurrent updates on one row (AC-12).

### S5: Queries: filter engine, lists, shaping · L
- `packages/domain/filter`: the Filter AST type, a Zod schema, and a **client evaluator** (`matches(row, filter, ctx)`) with relative values (`me`, durations).
- `apps/server/src/executor/filter-sql.ts`: a **SQL compiler** (AST → Drizzle `SQL`) driven by a per-model field map (column, type, join path).
- List helpers: `listQuery({model, filter, orderBy, limit, cursor, includeArchived})` with opaque cursors and visibility applied in SQL. Count and groupBy helpers.
- **`fields` projection** with dot-paths, validated against the output schema, with suggestions for unknown paths (AC-7).
- **Conformance harness:** a fixture model with every field type, 200+ generated filters (fast-check), asserting that the client evaluator and the SQL compiler agree (AC-6). It is re-run per real model as models are added (M1+).

### S6: HTTP exposure · M
- `POST /api/ops/:name`, `GET /api/ops` (catalog filtered by actor), `GET /api/openapi.json` (generated, no auth).
- **Auth hook:** an `Actor` resolver interface. A test-only header actor is used until PLAN-001 S3 provides sessions and CSRF.
- **Rate limiting:** an in-memory token bucket per actor and kind (defaults from SPEC-003 §9). The store interface allows Postgres-backed limits later if multi-process.
- **Idempotency:** migration `api_idempotency` (actor_id, client_mutation_id, result jsonb, created_at). A 24 h TTL cleanup job is registered in M0 as a startup-scheduled pg-boss job, so pg-boss setup lands here (a minimal ADR-0010 slice).
- **Tests:** one definition shows up in all three surfaces with no glue (AC-1), idempotent replay (AC-8), rate-limit 429 with `Retry-After`.

### S7: Registry lint & catalog snapshot · S
- `pnpm registry:lint` (in CI stage 1) implementing the 8 rules of SPEC-003 §11, plus contract tests that run every op's `examples` against the seed fixture.
- `catalog.snapshot.json` is committed. Rule 8 diffs the current catalog against the snapshot, and `pnpm registry:snapshot` updates it on release.
- **Negative fixtures:** one deliberately broken op per rule in `packages/operations/test/lint-fixtures/` (AC-9).

## 2. Modules touched
`packages/operations/*`, `packages/domain/{refs,filter}/*`, `apps/server/src/executor/*`, `apps/server/src/http/ops.ts`, `apps/server/src/jobs/` (pg-boss bootstrap), migrations (`event_outbox`, `api_idempotency`, pg-boss schema), `scripts/registry-lint.ts`.

## 3. Migration & rollback
New tables `event_outbox` and `api_idempotency`, plus the pg-boss schema. All are additive. Rollback = revert the code; the tables are left unused.

## 4. Test plan (AC → test)

| AC | Test |
|---|---|
| AC-1 | `server/test/ops-surfaces.int.test.ts` |
| AC-2 | `server/test/resolvers.int.test.ts` |
| AC-3 | `server/test/executor-stages.int.test.ts` (one case per stage) |
| AC-4 | `server/test/executor-readonly.int.test.ts` |
| AC-5 | `server/test/executor-atomic.int.test.ts` |
| AC-6 | `server/test/filter-conformance.int.test.ts` (fast-check) |
| AC-7 | `domain/test/fields.test.ts` |
| AC-8 | `server/test/idempotency.int.test.ts` |
| AC-9 | `operations/test/lint.test.ts` with fixtures |
| AC-10 | `operations/test/compact-schema.test.ts` |
| AC-11 | `server/bench/executor.bench.ts` (Vitest bench, asserted in CI) |
| AC-12 | `server/test/executor-concurrency.int.test.ts` |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Filter semantics drift between the client and SQL (nulls, case, dates, timezones) | The conformance harness is mandatory for every model. Edge-value generators (null, empty, unicode, DST boundaries). |
| Generic typing of `defineOperation` gets too complex | Keep generics to input and output only. Accept small `as` casts in internals, never in op definitions. |
| Zod JSON Schema output too verbose for MCP | Compact schema is our own renderer, tested against the token budget |
| Executor becomes a god-object | Split each stage into its own module with a typed `ExecutionState` pipeline, and unit-test each stage |
