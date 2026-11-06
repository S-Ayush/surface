---
paths:
  - 'packages/operations/**'
  - 'apps/server/src/executor/**'
  - 'apps/server/src/handlers/**'
---

# Operations (registry + executor)

Spec: `docs/06-specs/SPEC-003-operation-registry-executor.md`. Decisions: ADR-0011 (registry) and ADR-0012 (MCP shape).

- **One definition, every surface:** every query or mutation is a `defineOperation(...)` in `packages/operations`. That single definition powers the web client (`dispatch`), `POST /api/ops/:name`, the command menu and MCP (`search_operations` / `execute_operation`). Never add a bespoke endpoint for something that should be an operation.
- **Names:** `<domain>.<verb>` with a camelCase verb (`team.update`, `issue.addLabel`, `user.setRole`). Summaries are ≤ 80 characters, in sentence case.
- **Required fields** (registry lint, SPEC-003 §11): `summary`, `description`, ≥ 2 `keywords`, ≥ 1 `example` that validates and runs against the seed fixture, `permission`, and `destructive: true` on delete or remove ops. Web-used mutations need `optimistic`. Read SPEC-003 §11 before adding an operation, and run `pnpm registry:lint` once it exists.
- **References:** inputs that point at another entity use reference types (`TeamRef`, `UserRef`, `IssueRef`, ...) that accept human-readable forms (`ENG`, `me`, `ENG-123`), never a raw `z.string().uuid()`.
- **Permissions:** predicates come from the shared helpers (`p.admin`, `p.teamMember`, ...) and carry a human-readable failure reason. Visibility failures are `NOT_FOUND`, not `FORBIDDEN`.
- **Handlers:** write only through `ctx.repo`, emit domain events with `ctx.emit()`, and take time from `ctx.now`. A handler never commits, retries, or calls the network.
- **`optimistic(store, input)`** must be deterministic and side-effect free apart from the store. Leave server-computed values (issue numbers, timestamps) as placeholders.
- **Schema changes:** never make a breaking change to a released operation's input or output (removing a field, newly requiring one, narrowing a type). Add a new field or op and mark the old one `deprecated`.
