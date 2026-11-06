# PLAN-003: Operation Registry & executor

Implements: [SPEC-003](../06-specs/SPEC-003-operation-registry-executor.md) · Status: **Ready** · Order: **2nd** · Depends on: PLAN-004 S1–S3

---

## 1. Slices

### S1: Registry core (`packages/operations`) · M · ✅ Done 2026-11-06
- `defineOperation()` with the full field set of SPEC-003 §3.1, typed generics so `input` and `output` types flow to the client `dispatch` and the server `handler`.
- A `registry` map built from an explicit `index.ts` barrel (no filesystem globbing, so the code is tree-shakeable for the client).
- Name, domain, and summary validation at definition time (throws in dev and tests).
- **Schema export:** `toJsonSchema()` (Zod JSON Schema export plus `x-surface-ref` annotations) and `toCompactSchema()` (flat field map).
- `ui` metadata types (title, icon, contexts, shortcut).
- **Tests:** definition validation, schema export snapshots, compact schema token estimate < 400 (AC-10).

> **As built (2026-11-06).**
> - **Versions:** `zod` ^4.6.7 added to `@surface/operations` (the server already pins the same version, so both share one Zod instance and one metadata registry). No other new dependencies; JSON Schema export uses Zod 4's built-in `z.toJSONSchema` (draft 2020-12, `unrepresentable: 'any'`).
> - **Structure:** `src/define.ts` (`defineOperation`, `OperationDef`, `AnyOperation`, `InputOf` / `ParsedInputOf` / `OutputOf`, `definitionProblems`, `OperationDefinitionError`), `domains.ts`, `permission.ts`, `optimistic.ts`, `ui.ts`, `registry.ts` (`createRegistry`), `schema.ts` (`toJsonSchema`, `toCompactSchema`, `estimateTokens`), and `ops/index.ts` with the explicit `ALL_OPERATIONS` list and the `registry` built from it (empty until S4). `SURFACE_REF_KEY = 'x-surface-ref'` lives in `packages/domain/src/refs.ts`, so S2's reference types can set it without depending on `operations`.
> - **Typing:** generics are `Name`, `Kind`, `In`, `Out`. `InputOf` is the caller side (`z.input`, used by `examples` and client `dispatch`); `ParsedInputOf` is what `permission`, `optimistic` and handlers get (`z.output`). Callbacks use method syntax so concrete ops are assignable to `AnyOperation`. `optimistic` on a query is a type error and a runtime error.
> - **Deviations:**
>   - Definition checks run **always**, not only in dev/tests: they are cheap, run once at module load, and avoid reading the environment in a shared package.
>   - Checked at definition time: name pattern, `kind`, domain, summary (non-empty, ≤ 80, starts with a capital), description (non-empty, ≤ 400), no `optimistic` on queries. Keyword and example counts, example validity and the other lint rules stay in S7.
>   - The name prefix is **not** required to equal `domain`, because domain-model §7 files `reaction.toggle` under `comment`, `projectUpdate.*` under `update`, `apiKey.*` under `platform`, and so on. A `debug` domain was added for internal test ops (S4, PLAN-002 `DebugItem`).
> - **Notes for later slices:**
>   - **S2:** reference schemas must carry `.meta({ [SURFACE_REF_KEY]: 'TeamRef', description: '<accepted formats>' })`; the annotation survives `.optional()`, `.nullable()`, `.describe()` and arrays, and both exports read it. `packages/domain` needs `zod` as a dependency for the ref types (CLAUDE.md's "no deps" for domain means no workspace deps; dependency-cruiser enforces exactly that).
>   - **S3:** implement `PermissionPredicates` (`permission.ts`). Refs arrive as `ResolvedRefs` keyed by input field; a ref is a row or an array of rows. Every predicate returns `false` for `undefined`, and for an array every element must pass.
>   - **S4:** add `debug.echo` / `debug.touch` to `ops/` and to `ALL_OPERATIONS`; AC-10's test then covers them automatically. `registry.get()` returns `undefined` for unknown names; nearest-name suggestions for `UNKNOWN_OPERATION` are the executor's job.
>   - **S6 / M6:** `toCompactSchema(schema, io)` gives `{ path: { type, required?, enum?, format?, default?, description? } }`; nested paths use `.`, array elements `[]`, and a non-object root uses the key `$`. `toJsonSchema` output keeps its `$schema` key; strip it when embedding in OpenAPI.
>   - **PLAN-002 S8 (session D):** implement `OptimisticStore` (`optimistic.ts`): `now`, `get`, `patch`, `insert`, `archive`, `remove`, with model names as strings and refs in any accepted form.
>   - **AC-10:** `estimateTokens` is chars ÷ 3 (deliberately high). The registry is empty, so the test currently runs against the SPEC-003 §3 `team.update` shape and a §7.1 list shape (`test/fixtures.ts`), plus every registered op as they arrive.

### S2: Reference types & resolvers · M · ✅ Done 2026-11-06
- `packages/domain/refs.ts`: Zod ref types `TeamRef`, `UserRef`, `StatusRef`, `LabelRef` (and stubs for Issue, Cycle, Project, Initiative, Document, View, which throw "not available until M1+").
- Parsing of each format (uuid, key, email, displayName, `me`, names).
- **Server resolver interface** `resolve(def, input, actor, tx)`: dependency-ordered (scoped refs after their scope), with visibility applied via `sync_groups && actorGroups`, ambiguity errors carrying candidates, and invisible rows reported as `NOT_FOUND`.
- **Client resolver interface** over the store, implemented in PLAN-002 S6. Only the interface is defined here.
- **Tests:** a resolver test per ref type and format, plus ambiguity and invisibility (AC-2), using fixture tables in the test DB.

> **As built (2026-11-06).**
> - **Versions:** `zod` ^4.6.7 added to `@surface/domain` (same version as `operations` and the server). CLAUDE.md now says domain has "no workspace deps; Zod only", which is what dependency-cruiser enforces; S5's Filter schema needs it too.
> - **Domain (`packages/domain/src/refs.ts`):** `TeamRef`, `UserRef`, `UserRefIncludingInactive`, `StatusRef`, `LabelRef`, and the M1+ stubs `IssueRef`, `CycleRef`, `ProjectRef`, `InitiativeRef`, `DocumentRef`, `ViewRef`. Each is a Zod schema with format validation and metadata (`x-surface-ref`, a description of accepted formats, and for scoped refs `x-surface-ref-scope`, default `team`). `scopedTo(ref, field)` re-scopes. Parsers `parseTeamRef`, `parseUserRef`, `parseNamedRef`, `parseIssueRef`, `parseCycleRef` are shared by both sides. `RefEntity` moved here from `operations` (re-exported there). **Client interface:** `ClientRefResolver.resolve(type, value, { scopeTeamId?, allowInactive? }) → RefLookup` (`found` / `notFound` / `ambiguous`), for PLAN-002 S6.
> - **Deviation:** parsed input keeps the reference **as the caller wrote it** (no Zod transform to a parsed form), so inputs stay plain JSON for the mutation queue and idempotency; resolvers parse at lookup time.
> - **Server (`apps/server/src/executor/refs/`):** `resolveRefs(def, input, actor, tx) → ResolvedRefs`, keyed by dot-path (`team`, `owner.user`, `labels` → array). `refPlan(def)` reads ref locations from the input's JSON Schema (cached per op): top-level, nested-object and array-of-refs fields. Refs in unions or arrays of objects throw `RefPlanError` rather than reaching a handler unresolved. `StatusRef`/`CycleRef` without their scope field in the schema also throw `RefPlanError`; `LabelRef` without one means workspace labels only. `executor/errors.ts` has `SurfaceError(code, message, { issues, candidates })`; S4 adds the HTTP mapping.
> - **Rules decided (SPEC-003 §4 and Decisions Q4, Q5 updated):** names are case-insensitive with an exact-case match preferred; scoped ids resolve only within their scope; a deactivated user is `INVALID_INPUT`; the system actor bypasses visibility; candidates (max 10) sort with `COLLATE "C"` so their order doesn't depend on the locale. Stub ref types throw a plain `Error` ("IssueRef is not available until M1"), which S4 will report as `INTERNAL`.
> - **Tests:** `packages/domain/src/refs.test.ts` (formats, schema metadata), `apps/server/test/ref-plan.test.ts` (planner), `apps/server/test/resolvers.int.test.ts` (AC-2: 28 cases across every type and format, ambiguity with candidates, private-team invisibility identical to absence, candidates filtered by visibility).
> - **Notes for later slices:**
>   - **PLAN-001 S1:** the resolvers query `teams(id, key, name, private, sync_groups)`, `users(id, email, name, display_name, role, active, sync_groups)`, `workflow_statuses(id, team_id, name, category, sync_groups)` and `labels(id, team_id, parent_id, name, is_group, sync_groups)`. Keep those names, or update `refs/sources.ts`. Store `users.email` lowercase and `teams.key` uppercase (the lookups compare directly). Add `lower(display_name)` / `lower(name)` indexes if lookups show up in profiles. Then switch `resolvers.int.test.ts` from its `ref_fixture` schema to the real tables.
>   - **S3:** `ResolveActor` (`kind`, `userId?`, `groups`) is a structural subset of the planned `Actor`. Resolved rows carry `syncGroups` for `p.canSee`. `p.teamMember` needs membership for **public** teams too, which neither the groups nor the resolved team row provide; S3 must add it (e.g. `teamIds` on the actor).
>   - **S4:** call `resolveRefs` at step 7 inside the transaction, and map `RefPlanError` and stub errors to `INTERNAL`.

### S3: Actor & permission predicates · S · ✅ Done 2026-11-06
- `Actor` = `{ kind: user|api|mcp|system, userId?, role?, groups: string[], apiKey?: {scope, teamIds, allowDestructive} }`.
- Predicate helper `p`: `any`, `admin`, `self`, `teamMember`, `owner`, `canSee`, each with a human-readable failure reason.
- Key-scope checks (read keys allow queries only; `destructive` requires `allowDestructive`; `teamIds` narrowing). These are unit-tested now and wired to real keys in M6.
- Test helpers `actorFor(user)` and `systemActor()`. Sessions are wired in PLAN-001 S3.

> **As built (2026-11-06).**
> - **Where:** `packages/domain/src/permissions.ts` holds `Actor`, `ApiKeyScope`, `syncGroupsFor`, `userActor`, `systemActor`, `canSeeGroups`, and `bindPredicates(actor) → { p, allowedWho() }`, so the client's command-menu pre-check runs the same code. `PermissionPredicates`, `ResolvedRef(s)` moved there from `operations`, which re-exports them and adds `evaluatePermission(def, actor, refs, input)` and `forbiddenReason`. Key scope is server-only: `apps/server/src/executor/key-scope.ts` (`keyScopeProblem`, `narrowToKeyTeams`, `refOutsideKeyTeams`, `teamIdOf`). Test helpers `actorFor(user, via?)` and `systemActor` are in `apps/server/test/helpers.ts`.
> - **Deviation (Actor shape):** `Actor` gains `memberOf: string[]` (every team the user belongs to). `p.teamMember` needs public-team membership, which sync groups don't carry. PLAN-001 S3 fills it from `team_memberships` together with `groups`.
> - **Predicates:** `false` for a missing reference; every row must pass for a list, and an empty list fails; the system actor passes every predicate (permissions.md §1). Each failing predicate records who it allows ("Admins", "members of Engineering", "that user themselves", "its creator"/"its owner", "people who can see it", "signed-in users"); the reason is `Only <who, joined with "or"> can <summary, first letter lowercased>.`, or `You don't have permission to <summary>.` when no audience was recorded.
> - **Key scope:** read keys get `FORBIDDEN` for mutations, and destructive ops need `allowDestructive`, with reasons that say which key to use. `teamIds` narrowing works in two steps. First, private-team groups and memberships outside the key are dropped before resolving. Second, after resolving, `refOutsideKeyTeams` finds refs belonging to other teams (team id, or `teamId` on statuses and labels). The executor must report those as `NOT_FOUND`, never `FORBIDDEN`. Admin operations need no extra rule: the owner's role plus `read_write` already apply.
> - **Notes for later slices:**
>   - **S4:** order: `keyScopeProblem` (step 3) → `narrowToKeyTeams` → `resolveRefs` → `refOutsideKeyTeams` → `NOT_FOUND` → `evaluatePermission` (step 8).
>   - **S5:** list queries for a key with `teamIds` must also filter by team in SQL, because public teams share the `workspace` group.

### S4: Executor pipeline · L · ✅ Done 2026-11-06
- `apps/server/src/executor/execute.ts` implementing the SPEC-003 §6 steps 1–14.
- Transaction wrapper: `READ ONLY` for queries, and up to 3 retries with jitter on serialization or deadlock errors (E5).
- **Handler context:** `actor`, `refs`, `tx`, `repo`, `query`, `emit`, `now`, `log`. `repo` is an **interface** here, with a temporary passthrough implementation that writes rows and buffers changes. PLAN-002 S2 replaces it with the sync-logging repo.
- **Outbox:** a migration for `event_outbox` (`id`, `type`, `occurred_at`, `actor`, `subject`, `changes`, `data`, `processed_at`). `emit()` buffers events and inserts them before commit.
- **Error model:** `SurfaceError` classes with codes, the HTTP mapping table, correlation IDs, and `INTERNAL` that never leaks a stack.
- **Logging and metrics:** `op`, `actorKind`, `durationMs`, `outcome`, and a histogram per operation.
- **Test-only ops:** `debug.echo` (query) and `debug.touch` (mutation), both marked `internal`.
- **Tests:** stage-by-stage failures (AC-3), read-only enforcement (AC-4), atomic rollback with an injected failure after the handler (AC-5), overhead benchmark < 2 ms p95 (AC-11), and 50 concurrent updates on one row (AC-12).

> **As built (2026-11-06).**
> - **Structure (`apps/server/src/executor/`):**
>   - `execute.ts`: `createExecutor({ pool, registry, handlers, log, allowInternal, metrics?, rateLimiter?, repoFactory?, checks?, retries?, backoff?, clock? }).execute(op, input, actor, { correlationId?, clientId?, seq? })`, and `missingHandlers()`;
>   - `transaction.ts`, `context.ts` (`HandlerContext`, `handler()`, `ctx.query.get`), `repo.ts` (the `Repo` / `TransactionRepo` interface and `passthroughRepo`), `errors.ts` (`HTTP_STATUS`, `OperationError`, `INTERNAL_MESSAGE`), `rate-limit.ts` (an interface plus `unlimited`), `metrics.ts` (`surface_operation_duration_seconds{op,kind,outcome}`), `suggest.ts`, `log-error.ts`;
>   - outside the executor folder: `sync/models.ts` (`SYNCED_MODELS`), `db/uuidv7.ts`, `handlers/` (`HANDLERS`, `debug/echo.ts`, `debug/touch.ts`), and `debug.echo` / `debug.touch` in `packages/operations/src/ops/debug.ts`.
> - **Migration `0001_executor_outbox`:** `event_outbox`, as planned plus a nullable `last_sync_id` (the events.md envelope has it; PLAN-002 S2 fills it from `flush()`), with a partial index on unprocessed rows. Also **`debug_items`** (`id`, `title`, `counter`, `sync_groups` with a GIN index, timestamps), because AC-5 and AC-12 need a synced table before `teams` exists. **PLAN-002 S2 should reuse this table**, not create it.
> - **Isolation (SPEC-003 Decision Q6):** mutations run at `READ COMMITTED`, so concurrent writes to a row queue on its lock and the last write wins, as sync-protocol §5 requires. Queries run `REPEATABLE READ READ ONLY`, so resolution and the handler share one snapshot. Codes 40001 and 40P01 retry 3 times with 10–50 ms × attempt jitter, then return `CONFLICT`. Handlers that read, then write based on what they read, take `SELECT … FOR UPDATE`.
> - **Pipeline details:**
>   - `narrowToKeyTeams` runs before resolution. Team lookups now also filter by the key's `teamIds`, which covers statuses and labels through their scope. `refOutsideKeyTeams` is kept as a backstop.
>   - Output is validated with `def.output` **before COMMIT**. A bad output becomes `INTERNAL` and rolls back, and the parse strips undeclared fields.
>   - Queries may not `emit()`.
>   - Internal ops are callable only when `allowInternal` is true and the actor is a user. S6 sets that flag from `nodeEnv !== 'production'`.
>   - Unknown names get "Did you mean": close matches first, otherwise names in the same domain.
>   - E7: a primary-key `23505` in `repo.insert` becomes `CONFLICT`.
>   - E8: results include `deprecation`.
>   - `fields` shaping is left to S5.
> - **Security fix found while testing:** Drizzle's query errors carry bound **parameters** in `message`, `stack` and `params`. `loggableError()` logs only the SQL text and Postgres's error fields (`code`, `constraint`, `table`, …) and drops `detail`, which quotes values. `executor-readonly.int.test.ts` asserts that no bound value reaches the log. **Any other code that logs DB errors should use `loggableError()`.**
> - **Repo:** `passthroughRepo` implements `insert`, `update` (patch values may be `SQL`, e.g. atomic increments), `purge`, `changes()` and a no-op `flush()`. `archive`/`unarchive` wait for a model with `archivedAt` (PLAN-002 S2 / PLAN-001 S1). It does not recompute groups on update.
> - **Tests:**
>   - integration: `executor-stages.int.test.ts` (AC-3, plus E4, E5, E7, E8 and logging); `executor-readonly.int.test.ts` (AC-4, E3, no parameter leak); `executor-atomic.int.test.ts` (AC-5, and NOT_FOUND for an invisible item); `executor-concurrency.int.test.ts` (AC-12 on `debug.touch`, since `team.update` arrives in PLAN-001: 50/50 succeed, no lost updates); `executor-overhead.int.test.ts` (AC-11);
>   - unit: `executor-unit.test.ts` (suggestions, uuidv7, retry detection, the HTTP mapping, a handler for every registered op);
>   - the harness `test/executor.ts` holds test-only ops and a fixture `teams` table, reached through the pool's `search_path`.
> - **AC-11 as a test, not a bench:** Vitest benches can't fail CI, so the plan's `bench/executor.bench.ts` became `test/executor-overhead.int.test.ts`. It runs 500 samples after 100 warm-ups and prints p50/p95. Locally, p95 was 0.6 ms alone but **1.7 ms when run alongside the other integration files**. If it flakes in CI, run it in its own Vitest invocation instead of raising the limit.
> - **Notes for later slices:**
>   - **S5:** add `fields` to `ExecuteOptions` and shape after step 12.
>   - **S6:**
>     - build the executor in the app with `allowInternal: config.nodeEnv !== 'production'` and the `/metrics` registry;
>     - fail startup if `missingHandlers()` is non-empty;
>     - pass `request.id` as `correlationId`;
>     - map results with `HTTP_STATUS` and set `Retry-After` from `retryAfter`.
>   - **PLAN-002 S2:**
>     - replace `passthroughRepo` with the sync-logging repo, via `repoFactory`;
>     - `flush()` returns `lastSyncId`, which the outbox rows already record;
>     - NOTIFY after commit is still to be added.

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
| AC-11 | `server/test/executor-overhead.int.test.ts` (p95 over 500 samples; a bench cannot fail CI) |
| AC-12 | `server/test/executor-concurrency.int.test.ts` |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Filter semantics drift between the client and SQL (nulls, case, dates, timezones) | The conformance harness is mandatory for every model. Edge-value generators (null, empty, unicode, DST boundaries). |
| Generic typing of `defineOperation` gets too complex | Keep generics to input and output only. Accept small `as` casts in internals, never in op definitions. |
| Zod JSON Schema output too verbose for MCP | Compact schema is our own renderer, tested against the token budget |
| Executor becomes a god-object | Split each stage into its own module with a typed `ExecutionState` pipeline, and unit-test each stage |
