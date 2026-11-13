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
| `domain` | ✓ | One of the domain list in [domain-model §7](../03-domain/domain-model.md#7-operations-catalogue-seed-for-the-operation-registry), or `debug` for internal test operations (`internal: true`, never callable in production). M1 adds `draft` (`draft.save`, `draft.discard`, SPEC-012 §4.3). |
| `summary` | ✓ | ≤ 80 chars, imperative ("Update…", "List…") |
| `description` | ✓ | ≤ 400 chars. Mentions accepted reference formats and side effects. |
| `keywords` | ✓ | ≥ 2 natural-language phrasings a user or AI might use |
| `input` / `output` | ✓ | Zod schemas. Inputs use **reference types** (§4) for every foreign entity. |
| `permission` | ✓ | A predicate over the resolved refs (§5) |
| `destructive` | ✓ | `true` for deletes, purges, member removal, role changes, deactivation. Not for discarding the actor's own unsent draft (`draft.discard`, SPEC-012 D24, added 2026-11-13): it removes nothing anyone else sees, the user asked for it, and it is never offered in `Mod+K`. |
| `examples` | ✓ (≥ 1) | Must validate against `input` and run against the seed fixture |
| `ui` | mutations used in the UI | Title, icon, contexts, optional shortcut, and an optional `available(target, store)` predicate: the command applies only when it returns true for the command target and the client store (e.g. no edit command on an archived or deleted issue; "Restore issue" only on one). Added 2026-11-12 (SPEC-012, SPEC-015). Contexts are `UI_CONTEXTS` (`packages/operations/src/ui.ts`); M1 adds `comment` and `attachment` (SPEC-013, SPEC-014). An entry in any context other than `global` gives `refs` (for `comment`, `{ comment }`), as `checkOperationCommands` requires. |
| `optimistic` | client-dispatched mutations | Pure function over the client store (§8) |
| `inverse` | optional (M2) | Returns the op + input that undoes this call, given the pre-state |
| `secretOutput` | optional | `{ replayMessage }` when the output holds a secret shown once, such as a link whose hash alone is stored (`invite.create`, `user.createResetLink`). The output is never stored for an idempotent replay; see "Idempotency" (§9) |
| `contentParent` | content mutations | `(input) => parentRef`: the content parent (an Issue) the mutation writes under. Client dispatch awaits that parent's hydration before running `optimistic` (sync-protocol §4.2 rule 7). Declared by `issue.updateDescription` and the comment and reaction operations (SPEC-013). Added 2026-11-12 (SPEC-011 §5.3). |
| `internal` | optional | `true` hides the op from the API, the catalog, and MCP (e.g. `debug.touch`). Dev-only debug operations. |
| `systemOnly` | optional | `true`: callable only by the system actor, in every environment. Hidden from the API, the catalog, OpenAPI, MCP and the command menu (no `ui`). Exempt from §11 rule 2's seed run and rule 4. Used by `attachment.setPreview`, `issue.autoArchive` and `issue.autoClose`, which jobs run. Added 2026-11-12 (SPEC-014, SPEC-015). |
| `opaqueIds` | optional | Input paths (as §11 names them: `teamId`, `data.labelIds[]`) whose uuids the server stores without resolving: no reference type, no visibility check, nothing revealed about what they name. Exempt from §11 rule 4 for those paths only; an entry that is not a uuid path of the input fails rule 4. Only the operations in `OPAQUE_ID_OPERATIONS` (`packages/operations/src/lint.ts`) may set it: `draft.save` and `draft.discard` (SPEC-012 §4.3, D23). Adding one needs an ADR ([ADR-0025](../04-architecture/adr/0025-opaque-draft-ids.md)). Added 2026-11-13. |
| `deprecated` | optional | `{ since, replacedBy }` |

## 4. Reference types & resolution

Inputs accept **human-friendly references**. The executor resolves them to rows *before* the permission check, and treats an invisible row as `NOT_FOUND`, so existence never leaks.

| Type | Accepts | Resolves to |
|---|---|---|
| `TeamRef` | uuid · team key (`ENG`, case-insensitive) | Team |
| `UserRef` | uuid · email · displayName · `"me"` | User (active only, unless `allowInactive`) |
| `IssueRef` | uuid · identifier `ENG-123` (including **aliases** after team moves) | Issue. Narrowed by an API key's `teamIds` in SQL; an issue outside them is `NOT_FOUND` (2026-11-12, SPEC-011 §5.6) |
| `StatusRef` | uuid · status name (scoped to the issue's or target team) | WorkflowStatus |
| `LabelRef` | uuid · name (team label first, then workspace label) · `Group/Label` (spaces around `/` ignored) | Label. A uuid resolves to any visible label, with or without a team scope. A team label's **name** needs the team; without it a name resolves among workspace labels only. A bare name that matches several labels is ambiguous, with candidates listed as `Group/Label`; a name that matches in the team never falls through to the workspace, and several matches are settled only by a single exact-case match (2026-11-12, SPEC-010 §6). Because a uuid ignores `team`, an operation that changes a label checks permission on the label's own team (SPEC-010 D28) |
| `CommentRef` | uuid only | Comment of an issue the actor can see; `NOT_FOUND` otherwise (2026-11-12, SPEC-013) |
| `AttachmentRef` | uuid only | Attachment the actor can see (its issue is visible, after key narrowing) (2026-11-12, SPEC-014) |
| `CycleRef` | uuid · number · `"current"` · `"next"` · `"previous"` (scoped to a team) | Cycle |
| `ProjectRef`, `InitiativeRef`, `DocumentRef`, `ViewRef` | uuid · exact name (error if ambiguous) | entity |
| `InviteRef` | uuid only (from `invite.list`) | Invite. Server-only (SPEC-001 §5): the client resolver answers `NOT_FOUND`, and `invite.*` are Admin-only (PLAN-001 S5) |
| `SessionRef` | uuid only (from `session.list`) | Session: only the actor's own, unexpired. Server-only: the client resolver answers `NOT_FOUND` (PLAN-001 S6) |
| `FileRef` | uuid only (from `POST /files/upload`) | File. Server-only. Resolves any file the actor can see, by the one rule of `GET /files/:id` (SPEC-014 §4.2), after key narrowing: an unclaimed `attachment` or `inline` file only for its uploader, and never through a key limited to some teams; a file owned by an issue for whoever sees the issue (no uploader exception); a detached file for nobody; an avatar or logo by the M0 rule (its uploader, or anyone once a user or the workspace names it, SPEC-001 D12). Anything else is `NOT_FOUND`. The resolved row carries `purpose` and `uploaderId`. **Seeing is not owning:** `user.updateProfile` and `workspace.update` accept only the actor's own upload or the current avatar or logo, and answer any other file with the same `NOT_FOUND` as an unknown id (SPEC-014 D26) |

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
    if def.systemOnly && actor.kind ≠ "system"     → UNKNOWN_OPERATION
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

**Handler context (`ctx`):** `actor`, `refs`, `tx`, `repo` (the only writer of synced tables, per SPEC-002 §4.2), `query` (read helpers that apply visibility), `emit(event)` (outbox), `now()` (one timestamp per execution), `log`, `enqueueEmail(email)` (queued on the operation's transaction, so sent only if it commits; `false` without SMTP; throws on an address the email schema refuses), `closeSessions(userId, which)` (deletes sessions in the transaction; their sockets close on every replica only after the commit), `audit(event, fields, message)` (a SPEC-001 §10 line, written after the commit and only by the attempt that committed; a retried, rolled-back, rejected or replayed attempt writes nothing), `links` (single-use links, such as an Admin's reset link or an invite, stored on the operation's transaction and returned as URLs on `SURFACE_URL`). `enqueueEmail` and `closeSessions` since PLAN-001's S3 follow-up (2026-11-07), `audit` since PLAN-001 S9 (2026-11-12); `links` was missing from this list.

**Rules for handlers:** no network I/O inside the transaction (emails and webhooks go through the outbox) · deterministic given input + DB state · no direct `db.*` writes · may call other operations' *internal functions* (not `execute`) to compose, sharing the transaction.

## 7. Conventions for queries & outputs

### 7.1 Lists & pagination
Every `*.list` takes and returns:
```ts
input:  { filter?: Filter, orderBy?: OrderBy, limit?: number /*default 25, max 100*/, cursor?: string, includeArchived?: boolean }
output: { nodes: T[], pageInfo: { hasNextPage: boolean, endCursor: string | null }, totalCount?: number }
```
- `filter` uses the shared **Filter model** ([domain-model §5](../03-domain/domain-model.md#5-filter-model)). The server compiles it to SQL. A **conformance test** runs the same fixture filters through the client evaluator and the SQL compiler and asserts identical results.
- `OrderBy` is `{ field, direction?: "asc" | "desc" }` (default `asc`), one sort key per list; each list names its sortable fields and its default order. Ties are broken by id, and nulls sort last in both directions. (Q7)
- Cursors are opaque (base64url of the sort, the last row's key and its id). Pagination is keyset, so pages never repeat or skip rows that existed throughout. A cursor that doesn't decode, or that belongs to another sort, is `INVALID_INPUT`. `totalCount` is returned only by lists that opt in (it costs a second query).
- Visibility is applied **in SQL**, before limit, count, and ordering: the row's sync groups, and for an API key limited to some teams, the row's team.
- `includeArchived` (default `false`) lists archived rows too, on models that archive.
- List items use a **summary shape** by default (e.g. `IssueSummary`: id, identifier, title, status, priority, assignee, team, updatedAt). The full shape comes from `*.get`.

### 7.2 Output shaping (`fields`)
- `fields: string[]` with dot-paths (`["identifier", "status.name", "assignee.displayName"]`) projects the output. Unknown paths → `INVALID_INPUT` listing the valid top-level fields, with "did you mean" suggestions. It is checked before any work is done; at most 50 paths.
- Arrays are transparent (`labels.name` picks `name` from each label). On a list, paths address each node, and `pageInfo` and `totalCount` are always kept. A path to an object keeps the whole object.
- Relations in outputs are embedded **one level** as small objects (`{id, name}`). Deeper data needs another call.

### 7.3 Aggregates
`*.count` and `*.groupBy` take the same `filter` and `includeArchived`. `count` returns `{ count }`. `groupBy` also takes `groupBy` (the name of one of the model's groupings) and returns `[{ key, label, count, estimateSum? }]`, largest group first, with `key: null` and label "None" for rows without a value. They are required for issue (M1) and project (M3) domains.

### 7.4 Filter semantics
Added 2026-11-06 (PLAN-003 S5). The Filter tree is defined in [domain-model §5](../03-domain/domain-model.md#5-filter-model); this section fixes what it means, so the client evaluator and the SQL compiler agree (AC-6). Code: `packages/domain/src/filter/`, `apps/server/src/executor/filter-sql.ts`.

- **Shape:** `{ and: Filter[] }`, `{ or: Filter[] }`, or `{ field, op, value }`. There is no `not`; use `neq`, `nin` or `exists: false`. At most 8 levels of nesting, 200 nodes, 500 list values and 1,000 characters per string. Text may not contain NUL or broken Unicode (Postgres can't store it as sent).
- **Field types and operators** (each model declares its fields with `defineFilterFields`):

| Type | Stored as | Operators |
|---|---|---|
| `text` | text | `eq` `neq` `in` `nin` `contains` `exists` |
| `enum` | text | `eq` `neq` `in` `nin` `exists` |
| `number` | `integer`, `smallint` or `double precision` (types the wire delivers as JS numbers; not `bigint`/`numeric`/`real`) | `eq` `neq` `in` `nin` `lt` `lte` `gt` `gte` `exists` |
| `boolean` | boolean | `eq` `neq` `exists` |
| `instant` | `timestamptz(3)` | `lt` `lte` `gt` `gte` `exists` |
| `day` | `date` | `eq` `neq` `lt` `lte` `gt` `gte` `exists` |
| `ref` | uuid | `eq` `neq` `in` `nin` `exists` |
| `refs` (a set, e.g. labels) | `uuid[]` | `eq` (has) `neq` (lacks) `in` (has any of) `nin` (has none of) `exists` (non-empty) |

  Text has no ordering operators, because client and database collations order text differently.
- **Missing values** (null, or an empty/null set): a condition is false, except `neq`, `nin` and `exists: false`, which are true. So "assignee is not Ana" includes unassigned issues. Logic is two-valued everywhere.
- **Empty groups and lists:** `and: []` matches everything, `or: []` nothing; `in: []` matches nothing, `nin: []` everything.
- **Ids, not names:** `ref`/`refs` values are uuids or `me`. Names, keys and emails (the domain-model example's `"label": ["bug"]`) are turned into ids by the reference resolvers (§4) before the filter is resolved; the `*.list` helpers do this, with the same ambiguity and `NOT_FOUND` rules. M0 resolves team and user names; status and label names, which need a team, arrive with the issue list (M1).
- **Visibility:** a dot-path field (`status.category`, `parent.title`) reads another table, and its SQL must apply the actor's sync groups, so a filter can never match through a row the actor can't see (permissions.md §5).
- **Text:** `eq`/`in` compare exactly. `contains` ignores case using full Unicode lowercasing (JS `toLowerCase`, Postgres `lower()` with the ICU root collation `und-x-icu`), with no wildcards. Ids compare as lowercase uuids.
- **Relative values** are resolved once, in shared code, before evaluation or SQL compilation:
  - `me` → the acting user's id. Without a user it is an error.
  - **Instants** take an ISO-8601 date-time with an explicit offset, or a signed duration from now using weeks, days, hours and minutes (`-P14D`, `-PT30M`, `P1W`). A day is exactly 24 hours. Months and years are rejected (their length varies). The result must fall within years 1–9999 (UTC).
  - **Days** take `YYYY-MM-DD`, or a whole-day duration from *today in the actor's time zone* (`-P7D` is a week ago, `P0D` today).
  - Cycle-relative values (`current`, `next`, `previous`) arrive with cycles (M3; corrected 2026-11-12, SPEC-011 §12).
- **Instants compare at millisecond precision.** Synced tables store them as `timestamptz(3)`, so the replica holds exactly what the database compares.
- Errors (unknown field, unsupported operator, bad value) are `INVALID_INPUT` with the path into the filter and the valid choices. A bad evaluation context (a malformed user id, an unknown time zone in settings) is an internal error, not the caller's.

## 8. Client contract (`optimistic`)

- `optimistic(store, input)` runs in the client after local validation. It may read anything in the store (`store.get` by id or reference, `store.find(model, fields)` for the rows whose fields equal the given values, e.g. a membership by team and user) and write only through `store.patch / insert / archive / remove` on the overlay. Reads see base plus the pending mutations before this one.
- *Changed 2026-11-12 (PLAN-001 S8 follow-up):* `store.find` added, so `team.leave` and `team.removeMember` can find the membership they end (SPEC-001 D6). Additive.
- *Changed 2026-11-12 (M1 gate: SPEC-010, SPEC-011 §6.3, SPEC-015):*
  - `store.find` returns its results **ordered by id**, so replays are deterministic. It matches fields by equality, so it can't select rows by array membership (such as the issues whose `labelIds` hold a label).
  - `store.archive` also sets `archivedAt` to `store.now`; the new `store.unarchive(model, ref)` clears the archived flag and sets `archivedAt` to null. Archived state is readable: `store.get` and `store.find` return `archivedAt` like any field. No edit's `optimistic` predicts an unarchive; archived and deleted issues are read-only, and only restore unarchives.
  - When a content parent's rows are paged into memory, the overlay is rebuilt, so pending mutations on those rows replay against them.
  - An `optimistic` may **throw a refusal**: the operation is then not queued, and the user sees the message (e.g. `status.delete` while the store shows an issue on the status, SPEC-010 §6). When the store can't tell (it may not hold every issue), the prediction goes ahead and the server decides.
- It must be **pure and deterministic** (no `Date.now()`; use `store.now`, which is fixed per mutation). It must not call the network.
- Server-computed values (issue `number`, `sortOrder`, automation side effects) are not simulated. The UI shows placeholders until the delta arrives. An optimistic `sortOrder` takes its jitter from the row id, never from `Math.random`, so every rebuild of the overlay gives the same key (SPEC-011 §6.2).
- New entities use client-generated UUIDv7 IDs passed in `input.id`. The server accepts a client ID if it is unused and well-formed.

## 9. HTTP exposure

| Route | Auth | Notes |
|---|---|---|
| `POST /api/ops/:name` | Session cookie + CSRF header (M0). Bearer API key (M6). | Body: `{ input, fields?, clientMutationId? }`. Returns the executor result. |
| `GET /api/ops` | Same | Catalog: name, kind, domain, summary, description, keywords, compact input/output schema, examples, destructive. Filtered by the actor's scope. |
| `GET /api/openapi.json` | Public within the deployment (no data) | Generated OpenAPI 3.1, one path per operation that is neither internal nor `systemOnly` |

**Error → HTTP status:** `INVALID_INPUT` 400 · `UNAUTHENTICATED` 401 (nobody signed in; SPEC-001 E14) · `UNKNOWN_OPERATION` 404 · `NOT_FOUND` 404 · `FORBIDDEN` 403 · `CONFLICT` 409 · `RATE_LIMITED` 429 (+ `Retry-After`) · `CLIENT_OUTDATED` 426 · `CSRF_INVALID` 403 (a cookie-authenticated request without its CSRF token; the client refreshes it and resends, SPEC-001 Q7) · `SETUP_REQUIRED` 503 (the workspace isn't set up yet; SPEC-001 Q5) · `INSUFFICIENT_STORAGE` 507 (an upload would take the uploads volume below its free-space floor, SPEC-014 §4.6; added 2026-11-12, also in `ROUTE_ERROR_STATUS` and OpenAPI) · `INTERNAL` 500 (with a correlation ID; no stack traces).

**Error body:**
```json
{ "ok": false, "error": { "code": "INVALID_INPUT", "operation": "team.update",
  "message": "Invalid timezone 'PST'", "issues": [{ "path": ["timezone"], "message": "Unknown IANA timezone", "hint": "e.g. America/Los_Angeles" }],
  "correlationId": "01J…" } }
```

**Idempotency (API/MCP):** `clientMutationId` is stored for 24 h in `api_idempotency(actor_id, client_mutation_id, operation, result)`. A repeat returns the stored result. An operation with `secretOutput` stores no result (2026-11-12, PLAN-001 S9 security review): its repeat is `CONFLICT` with the op's `replayMessage`, which says how to get a new link. (Sync clients use `(clientId, seq)` instead, per SPEC-002; their stored results hold no output.)
- Ids are scoped to the API key, or to the user for session calls, and apply to mutations only (queries ignore them). 1–200 characters.
- The mutation's transaction claims the id before anything else, so concurrent repeats wait for the first and then replay it; if the first fails, nothing is stored and a repeat runs normally.
- A replay's body is byte-identical to the first response, and carries the header `Idempotent-Replayed: true`.
- Reusing an id for a different operation is `INVALID_INPUT`. A pg-boss job (`idempotency-prune`, hourly) deletes expired entries.

**Rate limits (defaults, configurable):** per actor, queries 600/min and mutations 120/min. Session actors are exempt from the query limit.
- A token bucket per API key (or user) and kind, holding a minute's allowance, so bursts up to the limit pass. In memory, per process: several web replicas each allow the full rate until a Postgres-backed limiter is needed. The system actor is never limited.
- M0 sets the limits in code (`tokenBucket()`); environment variables for them can follow when someone needs to change them.

**Other HTTP behaviour:**
- `GET /api/ops` returns `{ ok: true, result: { operations: [...] } }`: what the caller may run (no internal operations for API keys or in production; never `systemOnly` operations; queries only for read keys; no destructive operations for keys without "allow destructive").
- While the server is starting (before `/readyz` is ready), the operation routes answer 503 `UNAVAILABLE` with `Retry-After: 5`, because migrations may still be running.
- The request body is exactly `{ input, fields?, clientMutationId? }`; anything else is `INVALID_INPUT`.

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

How the rules are applied (D2):
- `pnpm registry:lint` prints the problems; a unit test runs the same lint, so `pnpm check` and CI fail on any. Rule 2's run against the seed fixture is a server contract test, and internal and `systemOnly` operations are exempt from it (their examples need test-only fixtures or the system actor).
- Rules 1 and 7 also carry the definition-time checks of §3.1: a description over 400 characters is rule 1; the summary's capital letter, the domain and the kind are rule 7. The name's prefix need not equal `domain` (domain-model §7 files `reaction.toggle` under `comment`).
- Rule 3: "used by the web client" means the mutation declares `ui` (§3.1).
- Rule 4: any `uuid`-format string in an input outside a reference type. Exempt: the top-level `id` of a `create*` operation (a client-generated id, E7), internal and `systemOnly` operations, and the paths an operation lists in `opaqueIds` (§3.1), which only the operations in `OPAQUE_ID_OPERATIONS` may do (ADR-0025, added 2026-11-13). `opaqueIds` on any other operation, or naming a path that is not a uuid of the input, fails rule 4.
- Rule 5: verbs starting `delete`, `remove`, `purge` or `deactivate`. Role changes are flagged `destructive` by review, not by name.
- Rule 6: verbs starting `list`. The operation is a query, its input carries every `listInput` field unchanged (same bounds and defaults, none required), and its output has the connection shape.
- Rule 8: `packages/operations/catalog.snapshot.json` holds the public operations' compact schemas (type, required, enum, format) as last released; `pnpm registry:snapshot` rewrites it on release. Inputs break when a field is removed, newly required (unless under a new optional parent), or narrowed (a type, `null` or an enum value no longer accepted, or a format added). Outputs break when a field is removed, no longer always present, or widened (a new type or `null`, or an enum dropped); new enum values in outputs are additive. A changed `kind` breaks. A released operation may disappear only if the snapshot shows it deprecated and its replacement exists; a deprecation must point at a public operation.

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
| Q7 | What is `OrderBy`? (added 2026-11-06, PLAN-003 S5) | One key, `{ field, direction }`, with id as the tie-break and nulls last. Views order by one field, with reverse (PRD FR-VIEW-04), and one key keeps cursors and indexes simple. A text sort key (such as a fractional manual order, M2) must compare bytewise (`COLLATE "C"`), so the client and the database agree. |
| D1 | (2026-11-06, PLAN-003 S5) What do filters mean for missing values, case, time and sets? | §7.4: two-valued logic with negations including missing values; ICU full-Unicode case folding for `contains`; relative values resolved in shared code at millisecond precision; no text ordering. |
| D2 | (2026-11-06, PLAN-003 S7) How are the §11 rules decided where the text leaves room? | As listed under §11: `ui` marks web mutations; raw uuids are allowed only as a create's own `id` and in internal ops; destructive and list rules go by verb prefix; rule 8 compares the public operations' schemas field by field (array items included, and input bounds, patterns and strictness), with new output enum values allowed. |

### Changes after acceptance

| Date | Change | Why |
|---|---|---|
| 2026-11-12 | **M1 acceptance gate.** §3.1: `ui.available(target, store)`; `UI_CONTEXTS` gain `comment` and `attachment`; new fields `contentParent` and `systemOnly`; the `draft` domain. §4: `IssueRef` narrows by key `teamIds`; `LabelRef` takes `Group/Label`, a uuid without a team, a team name only with its team; new `CommentRef` and `AttachmentRef`; `FileRef` follows issue ownership. §6: a `systemOnly` op called by anyone but the system actor is `UNKNOWN_OPERATION`. §7.4: cycle-relative values are M3. §8: `store.find` ordered by id, no array-membership lookup; `store.unarchive` and readable `archivedAt`; overlay rebuilt when content is paged in; `sortOrder` server-computed with id-based jitter; an `optimistic` may throw a refusal. §9: `INSUFFICIENT_STORAGE` → `507`; `systemOnly` ops are never listed. §11: `systemOnly` ops are exempt from rules 2 (seed run) and 4. | SPEC-010, SPEC-011, SPEC-012, SPEC-013, SPEC-014 and SPEC-015 §12, accepted at the M1 gate (2026-11-12). |
| 2026-11-12 | §4 `FileRef`: it resolves through the one file visibility rule (SPEC-014 §4.2), so any visible avatar or logo resolves, not only the actor's own; handlers that store a file id narrow it to the actor's own upload or the current one, with the unknown-id `NOT_FOUND` (SPEC-014 D25, D26). | PLAN-014 S1 and its review: one rule for every read of a file, without letting a user pin another user's file with the `RESTRICT` key |
| 2026-11-13 | §3.1: new field `opaqueIds`, allowed only on `draft.save` and `draft.discard` (`OPAQUE_ID_OPERATIONS`); the `destructive` row says discarding one's own draft is not destructive. §11 rule 4: the paths in `opaqueIds` are exempt, and `opaqueIds` elsewhere, or naming a path that is not a uuid of the input, fails the rule. | SPEC-012 D23 and D24 (PLAN-012 S5): a draft keeps ids the owner may no longer be able to see, and must not reveal whether they exist. [ADR-0025](../04-architecture/adr/0025-opaque-draft-ids.md). |
