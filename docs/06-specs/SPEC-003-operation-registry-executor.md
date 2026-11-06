# SPEC-003: Operation Registry & executor

Status: **Accepted** (2026-11-06) · Milestone: **M0** · Date: 2026-11-06
Implements: FR-API-01 · ADR-0005, ADR-0011 · [permissions §4](../03-domain/permissions.md#4-enforcement-points) · [sync-protocol §7](../04-architecture/sync-protocol.md#7-server-algorithm-executor)
Depends on: SPEC-004 (repo skeleton, DB)
Unblocks: SPEC-002 (mutations), SPEC-001 (all operations), SPEC-005 (`Cmd+K`), M6 (public API + MCP)

---

## 1. Problem & goal

Surface has one rule: **data changes only through operations**. The UI, `Cmd+K`, the HTTP API, and MCP must perform exactly the same actions, with the same validation, permissions, history, and sync. This spec defines:
1. how an operation is **declared** (`packages/operations`)
2. how the server **executes** it (the executor pipeline)
3. how it is **exposed** (`POST /api/ops/:name`, the catalog, OpenAPI)
4. the **conventions** every future operation must follow, enforced by a lint

## 2. Scope

**In scope:** the `defineOperation` API · reference types and resolvers · permission predicates · handler context · executor pipeline · error model · output shaping (`fields`) · pagination and filter conventions · the client-side `optimistic()` contract · command-menu metadata · `POST /api/ops/:name` with session auth · `GET /api/ops` catalog · `/api/openapi.json` · rate limiting · registry lint · JSON Schema and compact-schema export (used by MCP in M6).

**Out of scope:** API keys and bearer auth (M6, SPEC-06x; the executor already supports `actorKind = api | mcp`) · the MCP endpoint (M6) · `inverse()` for undo (the hook is defined here, implemented in M2).

## 3. Declaring an operation

```ts
// packages/operations/src/team/update.ts
export const teamUpdate = defineOperation({
  name: "team.update",                       // <domain>.<verb>, camelCase verb
  kind: "mutation",                          // "query" | "mutation"
  domain: "team",
  summary: "Update a team's name, icon, color or timezone",
  description: "Changes general settings of a team. The team key cannot be changed.",
  keywords: ["rename team", "team settings", "timezone"],
  input: z.object({
    team: TeamRef,                           // "ENG" | uuid
    name: z.string().min(1).max(64).optional(),
    icon: z.string().nullable().optional(),
    color: Color.optional(),
    timezone: TimeZone.optional(),
  }),
  output: TeamSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: "ENG", name: "Engineering" }],
  ui: { title: "Rename team…", icon: "pencil", contexts: ["team"], shortcut: null },
  optimistic: (store, input) => { store.patch("Team", input.team, pick(input, ["name","icon","color","timezone"])); },
});
```

```ts
// apps/server/src/handlers/team/update.ts
export default handler(teamUpdate, async (ctx, input) => {
  const team = ctx.refs.team;                // already resolved + visibility-checked
  return ctx.repo.update("Team", team.id, pickDefined(input, ["name","icon","color","timezone"]));
});
```

### 3.1 Field reference

| Field | Required | Rules |
|---|---|---|
| `name` | ✓ | `^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$`. Unique. Immutable once released (renaming = new op + deprecation). |
| `kind` | ✓ | `query` must not write. Enforced by a read-only transaction. |
| `domain` | ✓ | One of the domain list in [domain-model §7](../03-domain/domain-model.md#7-operations-catalogue-seed-for-the-operation-registry), or `debug` for internal test operations (`internal: true`, never callable in production) |
| `summary` | ✓ | ≤ 80 chars, imperative ("Update…", "List…") |
| `description` | ✓ | ≤ 400 chars. Mentions accepted reference formats and side effects. |
| `keywords` | ✓ | ≥ 2 natural-language phrasings a user or AI might use |
| `input` / `output` | ✓ | Zod schemas. Inputs use **reference types** (§4) for every foreign entity. |
| `permission` | ✓ | A predicate over the resolved refs (§5) |
| `destructive` | ✓ | `true` for deletes, purges, member removal, role changes, deactivation |
| `examples` | ✓ (≥ 1) | Must validate against `input` and run against the seed fixture |
| `ui` | mutations used in the UI | Title, icon, contexts, optional shortcut |
| `optimistic` | client-dispatched mutations | Pure function over the client store (§8) |
| `inverse` | optional (M2) | Returns the op + input that undoes this call, given the pre-state |
| `internal` | optional | `true` hides the op from the API, the catalog, and MCP (e.g. `debug.touch`) |
| `deprecated` | optional | `{ since, replacedBy }` |

## 4. Reference types & resolution

Inputs accept **human-friendly references**. The executor resolves them to rows *before* the permission check, and treats an invisible row as `NOT_FOUND`, so existence never leaks.

| Type | Accepts | Resolves to |
|---|---|---|
| `TeamRef` | uuid · team key (`ENG`, case-insensitive) | Team |
| `UserRef` | uuid · email · displayName · `"me"` | User (active only, unless `allowInactive`) |
| `IssueRef` | uuid · identifier `ENG-123` (including **aliases** after team moves) | Issue |
| `StatusRef` | uuid · status name (scoped to the issue's or target team) | WorkflowStatus |
| `LabelRef` | uuid · name (team label first, then workspace label) | Label |
| `CycleRef` | uuid · number · `"current"` · `"next"` · `"previous"` (scoped to a team) | Cycle |
| `ProjectRef`, `InitiativeRef`, `DocumentRef`, `ViewRef` | uuid · exact name (error if ambiguous) | entity |

Resolver rules:
- **Ambiguous** names → `INVALID_INPUT` with candidates (`"2 projects named 'Launch': …"`).
- **Scoped** refs (status, cycle, team label) resolve *after* their scope ref, using dependency order declared by the ref type.
- Resolution runs in the executor's transaction. Queries share one snapshot with the handler. Mutations run `READ COMMITTED` (Q6), so a referenced row can change or be deleted between resolution and the handler. A foreign-key violation from that race (`23503`) returns `CONFLICT` ("Something this change refers to was changed or deleted meanwhile. Reload and try again."), never `INTERNAL`.
- The client has equivalent resolvers over the local store, used by `optimistic()` and command-menu parsing.
- **Names and keys** match case-insensitively. When several rows differ only by case, an exact-case match wins; otherwise the name is ambiguous. (Q4)
- **Ids of scoped refs** resolve only within their scope: a status id from another team is `NOT_FOUND`, the same as an unknown id.
- **Deactivated users** referenced through a plain `UserRef` give `INVALID_INPUT` ("… is deactivated"), not `NOT_FOUND`, because users are visible to everyone. Fields that must accept them use the `allowInactive` variant. (Q5)
- The **system actor** sees every row; visibility applies to user, API and MCP actors.

## 5. Permissions

`permission: (p, refs, input) => boolean` uses a predicate helper `p` bound to the actor:

| Predicate | Meaning |
|---|---|
| `p.any()` | Any authenticated active user |
| `p.admin()` | Actor's role is Admin |
| `p.self(user)` | The ref is the actor |
| `p.teamMember(team)` | Actor is a member of the team |
| `p.canSee(entity)` | The entity's sync groups intersect the actor's (implicitly checked for every ref) |
| `p.owner(entity, field = "creatorId")` | Actor owns the entity |

The executor enforces, in order: **key scope** (M6: read keys → queries only; `destructive` needs `allowDestructive`; `teamIds` narrows visibility) → **visibility of every ref** → **the operation's predicate**. A failed predicate returns `FORBIDDEN` with a human-readable reason (`"Only Admins can change roles"`).

## 6. Executor pipeline

```
execute(opName, rawInput, actor, opts{fields?, clientMutationId?, clientId?, seq?})
 1. def = registry.get(opName)                     → UNKNOWN_OPERATION (+ nearest names)
 2. if def.internal && actor.kind ≠ "user"(dev)    → UNKNOWN_OPERATION
 3. scope check (actor kind / key scope)           → FORBIDDEN
 4. rate limit (actor, kind)                       → RATE_LIMITED (+ retryAfter)
 5. input = def.input.parse(rawInput)              → INVALID_INPUT (+ issues[path,message,hint])
 6. BEGIN (READ ONLY for queries)
 7.   refs = resolve(def, input, actor)            → NOT_FOUND | INVALID_INPUT(ambiguous)
 8.   permission(p, refs, input)                   → FORBIDDEN(reason)
 9.   result = handler(ctx, input)
10.   automations + invariant checks (mutations)   → CONFLICT(message)
11.   repo.flushSyncLog + outbox (mutations)
12. COMMIT; NOTIFY
13. output = shape(def.output, result, fields)     (§7)
14. log + metrics (op, actor kind, duration, outcome)
→ { ok: true, result, lastSyncId? } | { ok: false, error }
```

**Handler context (`ctx`):** `actor`, `refs`, `tx`, `repo` (the only writer of synced tables, per SPEC-002 §4.2), `query` (read helpers that apply visibility), `emit(event)` (outbox), `now()` (one timestamp per execution), `log`.

**Rules for handlers:** no network I/O inside the transaction (emails and webhooks go through the outbox) · deterministic given input + DB state · no direct `db.*` writes · may call other operations' *internal functions* (not `execute`) to compose, sharing the transaction.

## 7. Conventions for queries & outputs

### 7.1 Lists & pagination
Every `*.list` takes and returns:
```ts
input:  { filter?: Filter, orderBy?: OrderBy, limit?: number /*default 25, max 100*/, cursor?: string, includeArchived?: boolean }
output: { nodes: T[], pageInfo: { hasNextPage: boolean, endCursor: string | null }, totalCount?: number }
```
- `filter` uses the shared **Filter model** ([domain-model §5](../03-domain/domain-model.md#5-filter-model)). The server compiles it to SQL. A **conformance test** runs the same fixture filters through the client evaluator and the SQL compiler and asserts identical results.
- Cursors are opaque (base64 of the order key + id).
- Visibility is applied **in SQL**, before limit, count, and ordering.
- List items use a **summary shape** by default (e.g. `IssueSummary`: id, identifier, title, status, priority, assignee, team, updatedAt). The full shape comes from `*.get`.

### 7.2 Output shaping (`fields`)
- `fields: string[]` with dot-paths (`["identifier", "status.name", "assignee.displayName"]`) projects the output. Unknown paths → `INVALID_INPUT` listing the valid top-level fields.
- Relations in outputs are embedded **one level** as small objects (`{id, name}`). Deeper data needs another call.

### 7.3 Aggregates
`*.count` and `*.groupBy` take the same `filter`. `groupBy` returns `[{ key, label, count, estimateSum? }]`. They are required for issue (M1) and project (M3) domains.

## 8. Client contract (`optimistic`)

- `optimistic(store, input)` runs in the client after local validation. It may read anything in the store and write only through `store.patch / insert / archive / remove` on the overlay.
- It must be **pure and deterministic** (no `Date.now()`; use `store.now`, which is fixed per mutation). It must not call the network.
- Server-computed values (issue `number`, automation side effects) are not simulated. The UI shows placeholders until the delta arrives.
- New entities use client-generated UUIDv7 IDs passed in `input.id`. The server accepts a client ID if it is unused and well-formed.

## 9. HTTP exposure

| Route | Auth | Notes |
|---|---|---|
| `POST /api/ops/:name` | Session cookie + CSRF header (M0). Bearer API key (M6). | Body: `{ input, fields?, clientMutationId? }`. Returns the executor result. |
| `GET /api/ops` | Same | Catalog: name, kind, domain, summary, description, keywords, compact input/output schema, examples, destructive. Filtered by the actor's scope. |
| `GET /api/openapi.json` | Public within the deployment (no data) | Generated OpenAPI 3.1, one path per non-internal operation |

**Error → HTTP status:** `INVALID_INPUT` 400 · `UNKNOWN_OPERATION` 404 · `NOT_FOUND` 404 · `FORBIDDEN` 403 · `CONFLICT` 409 · `RATE_LIMITED` 429 (+ `Retry-After`) · `CLIENT_OUTDATED` 426 · `INTERNAL` 500 (with a correlation ID; no stack traces).

**Error body:**
```json
{ "ok": false, "error": { "code": "INVALID_INPUT", "operation": "team.update",
  "message": "Invalid timezone 'PST'", "issues": [{ "path": ["timezone"], "message": "Unknown IANA timezone", "hint": "e.g. America/Los_Angeles" }],
  "correlationId": "01J…" } }
```

**Idempotency (API/MCP):** `clientMutationId` is stored for 24 h in `api_idempotency(actor_id, client_mutation_id, result)`. A repeat returns the stored result. (Sync clients use `(clientId, seq)` instead, per SPEC-002.)

**Rate limits (defaults, configurable):** per actor, queries 600/min and mutations 120/min. Session actors are exempt from the query limit.

## 10. Schema export

- `toJsonSchema(def.input | def.output)`, via Zod's JSON Schema export, with reference types annotated (`"x-surface-ref": "IssueRef"`, plus a description of the accepted formats).
- `toCompactSchema(def.input)` gives a flat field map for MCP and `GET /api/ops`: `{ field: { type, required?, enum?, description } }`, with nested objects flattened to dot-paths. It aims to keep a typical operation under 400 tokens.

## 11. Registry lint (CI)

Fails the build if any operation:
1. lacks `summary`, `description`, `keywords` (≥ 2), `examples` (≥ 1), or `permission`
2. has examples that don't validate, or fail when executed against the seed fixture (contract test)
3. is a `mutation` used by the web client without `optimistic`
4. uses a raw `z.string().uuid()` for a foreign entity instead of a reference type
5. is a delete or remove op not flagged `destructive`
6. has a `*.list` op that doesn't follow §7.1
7. breaks the naming pattern, or has a summary over 80 chars
8. has a *breaking* schema change versus the last released catalog snapshot (a removed field, a newly required field, or a narrowed type) without a `deprecated` replacement

## 12. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | `"me"` used by a system actor | `INVALID_INPUT`: "'me' requires a user actor" |
| E2 | `IssueRef` given an old identifier after a team move | Resolves through IssueIdentifierAlias |
| E3 | A query op tries to write | The read-only transaction raises; the op fails `INTERNAL` and an error is logged (a bug, caught in tests) |
| E4 | A handler throws an unexpected error | Rollback, `INTERNAL` with a correlation ID; the full error goes to the logs only |
| E5 | A serialization or deadlock failure | Retried automatically up to 3 times with jitter, then `CONFLICT` |
| E6 | Both `fields` and the default summary apply | `fields` wins; it can request any field of the *full* output shape |
| E7 | A client-supplied ID collides | `CONFLICT: "id already exists"` (never silently overwrites) |
| E8 | A deprecated op is called | It executes, and the response includes `"deprecation": { replacedBy }` |

## 13. Acceptance criteria

| AC | Criterion | Test |
|---|---|---|
| AC-1 | One operation definition drives the client dispatch, `POST /api/ops/:name`, the `GET /api/ops` catalog entry, and the OpenAPI path, with no per-op glue code. | integration |
| AC-2 | Every reference type resolves all of its documented formats. Ambiguous names return candidates. Invisible rows return `NOT_FOUND` (not `FORBIDDEN`). | unit + integration |
| AC-3 | The pipeline order holds: scope, then rate limit, then validation, then resolution, then permission, then handler. Each failure returns its specified code and HTTP status. | integration (one test per stage) |
| AC-4 | Query operations run in read-only transactions. A write attempt fails in tests. | integration |
| AC-5 | A mutation's rows, sync-log entries, and outbox events commit atomically. An injected failure after the handler leaves none of them. | integration |
| AC-6 | **Filter conformance:** 200+ fixture filters give identical results in the client evaluator and the SQL compiler. | property / conformance |
| AC-7 | `fields` projection works with dot-paths and rejects unknown paths with suggestions. | unit |
| AC-8 | `clientMutationId` replay within 24 h returns the identical result without re-executing. | integration |
| AC-9 | The registry lint catches each rule violation in §11 (one failing fixture per rule). | CI |
| AC-10 | Compact schemas for all M0 ops are under 400 tokens each (tokenizer estimate). | unit |
| AC-11 | Executor overhead (excluding the handler) is under 2 ms p95. | perf |
| AC-12 | Serialization failures retry transparently. 50 concurrent `team.update` calls on one row all succeed or return `CONFLICT`; none return `INTERNAL`. | stress |

## 14. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Should `GET /api/openapi.json` require auth? | No. It contains no data, and it helps scripts. |
| Q2 | Should handlers be allowed to call `execute()` of other ops? | No. Compose through internal functions within one transaction, so there is one authorization point. |
| Q3 | Should we version operations (`issue.update@2`)? | No. Additive changes and deprecation only (lint rule 8). |
| Q4 | Are reference names case-sensitive? (added 2026-11-06, PLAN-003 S2) | No. Case-insensitive, with an exact-case match preferred, so `todo` finds "Todo" and typed or AI input works. |
| Q5 | What does a deactivated user in a `UserRef` return? (added 2026-11-06, PLAN-003 S2) | `INVALID_INPUT` with "… is deactivated", since the user is visible and `NOT_FOUND` would mislead. |
| Q6 | Which isolation level does the executor use? (added 2026-11-06, PLAN-003 S4) | Mutations `READ COMMITTED`: concurrent writes to a row wait for its lock and the last write wins (sync-protocol §5); handlers that read, then write, lock with `FOR UPDATE`. Queries `REPEATABLE READ READ ONLY`, one snapshot. Serialization failures and deadlocks still retry per E5. |
