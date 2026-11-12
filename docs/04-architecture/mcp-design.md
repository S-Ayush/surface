# Surface MCP Server: Design (structured search + execute)

Status: **Draft v0.2**  ·  Date: 2026-11-06  ·  Milestone: M6  ·  Related: VISION D10, ADR-0011 (Operation Registry)

> v0.2 replaces the code-execution (Cloudflare "Code Mode") approach from v0.1 with a **structured, sandbox-free** design. The AI sends only JSON; it never sends code.

---

## 1. Goal

Let a team's own AI clients (Claude Code, Cursor, Claude Desktop, and others) read and change Surface data through MCP:

- **Exactly two tools**, `search_operations` and `execute_operation`, so the context cost stays small and constant however many operations Surface grows to.
- **Progressive discovery:** the model looks up only the operations it needs.
- **No sandbox:** the model never sends code, only an operation name plus JSON input.
- **Same rules as the UI:** same permissions, validation, history, and live sync to every open client.

### Why not one MCP tool per operation?
Surface will have about 100+ operations. Listing each one as an MCP tool would put thousands of tokens of schemas into every conversation and make tool selection worse.

### Why not code execution (v0.1)?
Surface's catalog is around 100 operations, not thousands. A sandbox adds security exposure, ops work, and failure modes, and buys little at this size. We get most of its benefit by designing **task-sized operations** (§5).

---

## 2. Architecture

```
 AI client (Claude Code / Cursor)
        │  MCP Streamable HTTP · Authorization: Bearer sfc_<api key>
        ▼
 ┌──────────────────── surface-server (Docker) ───────────────────────┐
 │  /mcp handler                                                       │
 │   ├─ authenticate API key → actor (user) + scopes                   │
 │   ├─ search_operations ─► Catalog index (in-memory, MiniSearch)     │
 │   └─ execute_operation ─► Operation Registry                        │
 │                              ├─ scope + permission check            │
 │                              ├─ input validation (Zod)              │
 │                              ├─ reference resolution (ENG-123, me…) │
 │                              └─ handler → same transaction path     │
 │                                           as the web app            │
 │                                              ▼                      │
 │                     Postgres ─► lastSyncId ─► WebSocket deltas → all clients
 └─────────────────────────────────────────────────────────────────────┘
```

### 2.1 The Operation Registry (ADR-0011): the single source of truth
Every action in Surface is declared once:

```ts
defineOperation({
  name: "issue.update",
  kind: "mutation",                         // "query" | "mutation"
  domain: "issue",
  summary: "Update fields of an issue",
  description: "Change status, priority, assignee, labels, cycle, project, estimate, or title of one issue.",
  keywords: ["move", "assign", "reprioritize", "change status", "set cycle"],
  input: z.object({
    id: IssueRef,                           // "ENG-123" or UUID
    status: z.string().optional(),          // status name, e.g. "In Progress"
    priority: Priority.optional(),
    assignee: UserRef.optional(),           // email, display name, or "me"
    cycle: CycleRef.optional(),             // "current" | "next" | cycle number | UUID | null
    // ...
  }),
  output: IssueSchema,
  permission: "team:member",
  destructive: false,
  examples: [{ id: "ENG-123", cycle: "current", priority: "high" }],
  handler: async (ctx, input) => { /* ... */ },
});
```

The same registry generates the web client's mutations, the `Cmd+K` commands, the internal API (`POST /api/ops/:name` plus a generated OpenAPI doc), and both MCP tools. MCP is therefore a thin layer that cannot drift from the product.

---

## 3. The two tools

### 3.1 `search_operations`
Find which operations can do a task and how to call them.

**Input**
```json
{
  "query": "move issue to a cycle",   // required, natural language or keywords
  "domain": "issue",                  // optional filter: issue | cycle | project | team | view | ...
  "kind": "mutation",                 // optional: query | mutation
  "limit": 5                          // optional, default 5, max 10
}
```

**Output** (top matches, each self-contained enough to call directly)
```json
{
  "operations": [
    {
      "name": "issue.update",
      "kind": "mutation",
      "summary": "Update fields of an issue",
      "input": {
        "id":       { "type": "string", "required": true, "description": "Issue identifier, e.g. ENG-123" },
        "cycle":    { "type": "string|number|null", "description": "'current', 'next', cycle number, or null to remove" },
        "priority": { "enum": ["none","urgent","high","medium","low"] }
      },
      "example": { "id": "ENG-123", "cycle": "current" },
      "destructive": false
    },
    { "name": "issue.bulkUpdate", "...": "..." }
  ]
}
```

**How search works (no LLM, no external calls)**
- An in-memory **MiniSearch** index is built at boot from the registry. It indexes `name`, `summary`, `description`, `keywords`, and field names.
- Ranking uses fuzzy matching plus prefix matching, with boosts on `name` and `keywords`.
- The schema is rendered in a **compact form** (flat field map, enums inline, no deep JSON Schema noise) to keep responses small.
- An empty `query` with a `domain` returns just the list of operation names in that domain, which is useful for browsing.
- MCP annotation: `readOnlyHint: true`.

### 3.2 `execute_operation`
Run one operation.

**Input**
```json
{
  "operation": "issue.update",
  "input": { "id": "ENG-123", "cycle": "current" },
  "fields": ["identifier", "title", "cycle.name"],    // optional: trim the response
  "clientMutationId": "c1a2…"                         // optional: idempotency for retries
}
```

**Output**
```json
{ "ok": true, "result": { "identifier": "ENG-123", "title": "Fix login redirect", "cycle": { "name": "Cycle 14" } } }
```

**Error output** (written so the model can correct itself)
```json
{ "ok": false,
  "error": { "code": "INVALID_INPUT", "operation": "issue.update",
             "message": "Unknown status 'Doing' for team ENG.",
             "hint": "Valid statuses: Backlog, Todo, In Progress, In Review, Done, Canceled" } }
```
Error codes: `UNKNOWN_OPERATION` (with nearest-match suggestions), `INVALID_INPUT`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMITED`.

MCP annotations: `readOnlyHint: false`, `destructiveHint: true` (conservative, because it can run mutations).

---

## 4. Typical flow

> User: *"Move my started high-priority ENG issues into the current cycle."*

1. `search_operations({ query: "list issues with filters" })` → `issue.list`
2. `search_operations({ query: "update many issues cycle" })` → `issue.bulkUpdate`
3. `execute_operation({ operation: "issue.list", input: { team: "ENG", assignee: "me", statusCategory: "started", priority: ["urgent","high"] }, fields: ["identifier"] })`
4. `execute_operation({ operation: "issue.bulkUpdate", input: { ids: ["ENG-12","ENG-40"], cycle: "current" } })`

Clients usually cache what they found, so later tasks skip the `search_operations` step.

---

## 5. Operation design rules (what makes two tools enough)

Because the model cannot chain or filter in code, **operations must be task-sized**. These rules apply to every operation in the registry:

1. **Human-friendly references everywhere:** `ENG-123`, team keys, emails or display names, `"me"`, `"current"`/`"next"` for cycles, and status names. The model should rarely need a lookup call to find an ID.
2. **Bulk variants for common mutations:** `issue.bulkUpdate`, `issue.bulkCreate` (e.g. sub-issues from a list).
3. **Rich server-side filters on every `*.list`:** the same filter model the UI uses for views, plus `limit` (default 25, max 100), a `cursor`, and `orderBy`.
4. **`fields` trimming on every output,** with dot-paths for nested fields (`cycle.name`).
5. **Aggregate queries for common questions:** `issue.count`, `issue.groupBy` (by status, assignee, priority, label), `cycle.progress`, `project.progress`. These keep answers small.
6. **Every operation has `keywords` and at least one `example`.** CI fails if either is missing.
7. **Outputs stay small by default:** list items return a compact summary shape, and full detail needs an explicit `*.get`.

---

## 6. Security & permissions

- **Auth:** a personal API key (`Authorization: Bearer sfc_…`), created in Settings → API. The scope is **read** or **read-write**, and optionally limited to certain teams. (MCP OAuth may come *later*.)
- **Same authorisation as the UI:** private-team data is invisible unless the key owner is a member. `search_operations` hides operations the key can never call; for example, a read key sees no mutations.
- **Destructive operations** (`*.delete`, `team.archive`…) are blocked unless the key has the `allow-destructive` flag. Deletes are soft deletes that can be restored for 30 days; `issue.purge` deletes permanently (Admin only, SPEC-015) and is destructive.
- **Attribution:** every change made through MCP appears in issue history and the audit log as *"<user> via MCP (key name)"*.
- **Rate limits** apply per key, on calls per minute and mutations per minute.
- **Size limit:** responses are capped at about 24 KB, and a truncated response says how to narrow it (`fields`, `limit`, filters).
- **No secrets are exposable:** sensitive model fields are marked at the schema level and can never appear in outputs.

---

## 7. Transport & configuration

- **Endpoint:** `https://<surface-host>/mcp` (MCP Streamable HTTP), served by the same container. No extra service is needed.
- **Feature flag:** `SURFACE_MCP_ENABLED=true` in `.env`. Admins can disable it workspace-wide.
- **Client setup** is documented with copy-paste config for Claude Code, Cursor, and Claude Desktop.
- AI clients must be able to reach the Surface host (LAN or VPN). Surface makes **no outbound calls**.

---

## 8. Testing

| Layer | Tests |
|---|---|
| Registry lint | Every operation has a summary, description, keywords, an example, a permission, and schemas |
| Search quality | A golden set of queries maps to the expected top-3 operations (e.g. "assign to me" → `issue.update`) |
| Contract | Each operation's examples validate and run against a seeded DB |
| Authz | A matrix of key scope × private team × operation |
| **Agent evals** | About 30 natural-language tasks run through a real MCP client. Track success rate, number of tool calls, and tokens. |

---

## 9. Rollout

1. **M0–M1:** build the Operation Registry. Every feature registers its operations, with keywords and examples, from day one.
2. **M6:** internal API (`/api/ops/:name`) and API keys, then `search_operations`, then `execute_operation` with read-only keys, then read-write keys, then destructive operations.
3. Agent evals run in CI for releases.

## 10. Future extension (non-breaking)

- **`select` (JMESPath)** on `execute_operation`, for server-side filtering and reshaping of results. It is non-Turing-complete, so no sandbox is needed. Add it only if evals show responses getting too large.
- **`dryRun: true`**, to validate a mutation and preview its effects without committing.
- **MCP resources** (`surface://issue/ENG-123`) for read-only context attachments.
